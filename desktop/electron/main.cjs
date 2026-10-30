const { app, BrowserWindow, ipcMain, shell, dialog, Menu, nativeImage, Tray, globalShortcut, Notification } = require('electron')
const { join } = require('path')
const { exec, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { autoUpdater } = require('electron-updater')
const { TerminalManager } = require('./terminalManager.cjs')
const { createLocalShellRuntime, resolveShellProtocol } = require('./localShell.cjs')
const promptImageResizer = require('./promptImageResizer.cjs')
const serverConfigLib = require('./serverConfig.cjs')
const chatAttachment = require('./chatAttachment.cjs')
const desktopPrefsLib = require('./desktopPrefs.cjs')
const { createTray } = require('./tray.cjs')
const { readFileBytes } = require('./localFileBytes.cjs')


app.setName('Mao')
// Windows 系统通知的前提：appUserModelId 必须与 electron-builder 的 appId 一致（package.json）。
// 收件箱的 Electron 系统通知（P2）依赖它才能正常弹出并被任务栏正确归组。
app.setAppUserModelId('cn.etarch.mao.desktop')

// 单实例锁（P2 前置）：托盘常驻 / 开机自启 / dock 复活都要求同一时刻只有一个进程，
// 否则多实例会争用 auth.json 等 userData 资源。第二个实例启动后唤起主窗再退出。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // app ready 前禁止创建 BrowserWindow（真实 Electron 会抛未捕获异常）：未就绪时直接返回，
    // whenReady 链会把主窗建出来，不会漏掉「唤起」语义
    if (!app.isReady()) return
    const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
}

let mainWindow = null
/** 系统托盘实例（P2；app ready 后创建，退出时随进程销毁） */
let appTray = null
/** before-quit 已触发：close 事件不再拦截为隐藏，保证退出路径全量清理 */
let quitting = false
/** 当前已注册的全局快捷键（换键时精确注销旧键；app 退出时随进程销毁） */
let currentShortcutAccel = null
let currentWorkspace = ''
/** @type {Map<string, (approved: boolean) => void>} */
const pendingApprovals = new Map()
/**
 * 待派发的通知点击深链：点击时刻渲染层监听可能尚未注册（应用刚启动、
 * 页面加载中、窗口重建），立即 send 会丢。这里总是留一份，由渲染层桥接
 * 就绪后主动拉取（consume），收到后回执（ack）清除，防止页面重载后
 * 拿陈旧点击重复跳转。did-finish-load 补发仅在「尚未被拉取」时执行。
 */
let pendingNotificationClick = null
const terminalManager = new TerminalManager()
terminalManager.setEnvProvider(buildShellEnv)

const PRIVATE_DIFF_FIELD = 'file_change_diff'
const SNAPSHOT_LIMIT_BYTES = 512 * 1024
const PATCH_LIMIT_CHARS = 256 * 1024
const PATCH_CONTEXT_LINES = 3
const LCS_CELL_LIMIT = 2_000_000

let updaterInitialized = false
let updateDownloaded = false
let updateCheckPromise = null
let updaterStatus = 'idle'
let updaterProgressPercent = null

function utf8Bytes(text) {
  return Buffer.byteLength(text || '', 'utf-8')
}

function isBinaryContent(text) {
  const value = text || ''
  const checkLen = Math.min(value.length, 8192)
  for (let i = 0; i < checkLen; i++) {
    if (value.charCodeAt(i) === 0) return true
  }
  return false
}

function splitLines(text) {
  if (!text) return []
  return text.split(/\r\n|\r|\n/)
}

function lcsLength(oldLines, oldStart, oldEnd, newLines, newStart, newEnd) {
  const newLen = newEnd - newStart + 1
  let previous = new Array(newLen + 1).fill(0)
  let current = new Array(newLen + 1).fill(0)

  for (let i = oldStart; i <= oldEnd; i++) {
    for (let j = 1; j <= newLen; j++) {
      if (oldLines[i] === newLines[newStart + j - 1]) {
        current[j] = previous[j - 1] + 1
      } else {
        current[j] = Math.max(previous[j], current[j - 1])
      }
    }
    const temp = previous
    previous = current
    current = temp
    current.fill(0)
  }
  return previous[newLen]
}

function computeLineDelta(beforeContent, afterContent) {
  const oldLines = splitLines(beforeContent)
  const newLines = splitLines(afterContent)
  if (oldLines.length === 0) return { linesAdded: newLines.length, linesDeleted: 0 }
  if (newLines.length === 0) return { linesAdded: 0, linesDeleted: oldLines.length }

  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++
  }

  let oldSuffix = oldLines.length - 1
  let newSuffix = newLines.length - 1
  while (oldSuffix >= prefix && newSuffix >= prefix && oldLines[oldSuffix] === newLines[newSuffix]) {
    oldSuffix--
    newSuffix--
  }

  const oldChanged = oldSuffix - prefix + 1
  const newChanged = newSuffix - prefix + 1
  if (oldChanged <= 0) return { linesAdded: Math.max(0, newChanged), linesDeleted: 0 }
  if (newChanged <= 0) return { linesAdded: 0, linesDeleted: Math.max(0, oldChanged) }

  if (oldChanged * newChanged > LCS_CELL_LIMIT) {
    return { linesAdded: newChanged, linesDeleted: oldChanged }
  }

  const lcs = lcsLength(oldLines, prefix, oldSuffix, newLines, prefix, newSuffix)
  return { linesAdded: newChanged - lcs, linesDeleted: oldChanged - lcs }
}

function appendBounded(parts, state, text) {
  if (state.length >= PATCH_LIMIT_CHARS) {
    state.truncated = true
    return
  }
  const remaining = PATCH_LIMIT_CHARS - state.length
  if (text.length <= remaining) {
    parts.push(text)
    state.length += text.length
  } else {
    parts.push(text.slice(0, remaining))
    state.length += remaining
    state.truncated = true
  }
}

function buildUnifiedPatch(filePath, before, after) {
  const oldLines = splitLines(before)
  const newLines = splitLines(after)
  let prefix = 0
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++
  }

  let oldSuffix = oldLines.length - 1
  let newSuffix = newLines.length - 1
  while (oldSuffix >= prefix && newSuffix >= prefix && oldLines[oldSuffix] === newLines[newSuffix]) {
    oldSuffix--
    newSuffix--
  }

  const contextStart = Math.max(0, prefix - PATCH_CONTEXT_LINES)
  const oldContextEnd = Math.min(oldLines.length - 1, oldSuffix + PATCH_CONTEXT_LINES)
  const newContextEnd = Math.min(newLines.length - 1, newSuffix + PATCH_CONTEXT_LINES)
  const oldStartLine = contextStart + 1
  const newStartLine = contextStart + 1
  const oldCount = Math.max(0, oldContextEnd - contextStart + 1)
  const newCount = Math.max(0, newContextEnd - contextStart + 1)

  const parts = []
  const state = { length: 0, truncated: false }
  appendBounded(parts, state, `--- a/${filePath}\n`)
  appendBounded(parts, state, `+++ b/${filePath}\n`)
  appendBounded(parts, state, `@@ -${oldStartLine},${oldCount} +${newStartLine},${newCount} @@\n`)
  for (let i = contextStart; i < prefix && i < oldLines.length; i++) {
    appendBounded(parts, state, ` ${oldLines[i]}\n`)
  }
  for (let i = prefix; i <= oldSuffix && i < oldLines.length; i++) {
    appendBounded(parts, state, `-${oldLines[i]}\n`)
  }
  for (let i = prefix; i <= newSuffix && i < newLines.length; i++) {
    appendBounded(parts, state, `+${newLines[i]}\n`)
  }
  const sharedTailStart = Math.max(prefix, Math.max(oldSuffix + 1, newSuffix + 1))
  const sharedTailEnd = Math.min(oldContextEnd, oldLines.length - 1)
  for (let i = sharedTailStart; i <= sharedTailEnd; i++) {
    appendBounded(parts, state, ` ${oldLines[i]}\n`)
  }
  let content = parts.join('')
  if (state.truncated) {
    const suffix = '\n...[diff truncated]\n'
    content = content.slice(0, Math.max(0, PATCH_LIMIT_CHARS - suffix.length)) + suffix
  }
  return { content, truncated: state.truncated }
}

function buildFileChangeDiff(filePath, beforeContent, afterContent) {
  const before = beforeContent || ''
  const after = afterContent || ''
  if (isBinaryContent(before) || isBinaryContent(after)) {
    return {
      diff_mode: 'UNSUPPORTED',
      diff_unavailable_reason: '二进制文件无法生成文本 diff',
      patch_truncated: false
    }
  }
  if (utf8Bytes(before) <= SNAPSHOT_LIMIT_BYTES && utf8Bytes(after) <= SNAPSHOT_LIMIT_BYTES) {
    return {
      diff_mode: 'SNAPSHOT',
      before_content: before,
      after_content: after,
      patch_truncated: false
    }
  }
  const patch = buildUnifiedPatch(filePath, before, after)
  return {
    diff_mode: 'PATCH',
    patch_content: patch.content,
    patch_truncated: patch.truncated
  }
}

function asBoolArg(value, fallback = false) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value !== 0
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase()
    if (s === 'true' || s === '1' || s === 'yes') return true
    if (s === 'false' || s === '0' || s === 'no' || s === '') return false
  }
  return fallback
}

function lineAtIndex(content, index) {
  let lineNumber = 1
  let lineStart = 0
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') {
      lineNumber++
      lineStart = i + 1
    }
  }
  let lineEnd = content.indexOf('\n', index)
  if (lineEnd === -1) lineEnd = content.length
  let lineText = content.slice(lineStart, lineEnd)
  if (lineText.endsWith('\r')) lineText = lineText.slice(0, -1)
  return { lineNumber, lineText }
}

function applyEditMatch(content, oldString, newString, replaceAll) {
  if (oldString === '') {
    return { ok: false, replacements: 0, error: 'old_string 不能为空' }
  }
  const starts = []
  let idx = 0
  while (idx < content.length) {
    const found = content.indexOf(oldString, idx)
    if (found === -1) break
    starts.push(found)
    idx = found + oldString.length
  }
  const count = starts.length
  if (count === 0) {
    return { ok: false, replacements: 0, error: '文件中未找到 old_string' }
  }
  if (count > 1 && !replaceAll) {
    const maxLines = 20
    const maxPreviews = 8
    const occurrenceLines = starts.slice(0, maxLines).map((start) => lineAtIndex(content, start).lineNumber)
    const previewCount = Math.min(maxPreviews, starts.length)
    const previews = []
    for (let i = 0; i < previewCount; i++) {
      const { lineNumber, lineText } = lineAtIndex(content, starts[i])
      const preview = lineText.length > 120 ? lineText.slice(0, 120) + '…' : lineText
      previews.push(`  第 ${lineNumber} 行: ${preview}`)
    }
    const listed = count > maxLines ? `（仅列出前 ${maxLines} 处）` : ''
    return {
      ok: false,
      replacements: 0,
      occurrences: count,
      occurrence_lines: occurrenceLines,
      error: `old_string 在文件中出现 ${count} 次，默认只替换唯一匹配，未执行编辑。`
        + '请在 old_string 中补充更多上下文使其只出现一次，或传入 replace_all=true 以替换全部出现。'
        + `出现位置（行号从 1 起）${listed}：\n`
        + previews.join('\n')
    }
  }
  return {
    ok: true,
    updated: content.split(oldString).join(newString),
    replacements: count
  }
}

function writeEditedFile(resolvedPath, filePathArg, oldString, newString, replaceAll) {
  const content = fs.readFileSync(resolvedPath, 'utf-8')
  const match = applyEditMatch(content, oldString ?? '', newString ?? '', replaceAll)
  if (!match.ok) {
    const out = { success: false, replacements: 0, error: match.error }
    if (match.occurrences != null) {
      out.occurrences = match.occurrences
      out.occurrence_lines = match.occurrence_lines
    }
    return out
  }
  fs.writeFileSync(resolvedPath, match.updated, 'utf-8')
  const lineDelta = computeLineDelta(content, match.updated)
  return {
    success: true,
    replacements: match.replacements,
    file_change: {
      path: filePathArg,
      type: 'MODIFIED',
      lines_added: lineDelta.linesAdded,
      lines_deleted: lineDelta.linesDeleted
    },
    [PRIVATE_DIFF_FIELD]: buildFileChangeDiff(filePathArg, content, match.updated)
  }
}

/**
 * Get the full user PATH by executing a login shell.
 * macOS GUI apps don't load shell configs, so we need to manually resolve the PATH
 * that includes all user-configured tools (nvm, brew, cargo, etc.)
 */
let cachedUserPath = null
async function resolveUserPath() {
  if (cachedUserPath) return cachedUserPath

  const shell = process.env.SHELL || '/bin/zsh'
  console.log('[env] Resolving user PATH, SHELL:', process.env.SHELL, 'Using shell:', shell)
  console.log('[env] Current PATH:', process.env.PATH)

  return new Promise((resolve) => {
    // Use login shell to get full user environment
    const cmd = `${shell} -l -c 'echo $PATH'`
    console.log('[env] Executing:', cmd)

    exec(cmd, {
      timeout: 10000,
      env: { ...process.env, TERM: 'dumb' } // Ensure basic env
    }, (error, stdout, stderr) => {
      if (error) {
        console.error('[env] Failed to resolve user PATH via login shell:', error.message)
        if (stderr) console.error('[env] stderr:', stderr)
        resolve(process.env.PATH)
      } else {
        const userPath = stdout.trim()
        if (userPath && userPath !== process.env.PATH) {
          cachedUserPath = userPath
          console.log('[env] Resolved user PATH via login shell:', userPath.substring(0, 100) + '...')
          resolve(userPath)
        } else {
          console.log('[env] Login shell PATH same as current, using current PATH')
          resolve(process.env.PATH)
        }
      }
    })
  })
}

/**
 * Build environment with user's full PATH and current MAO_TOKEN from local auth store.
 */
async function buildShellEnv() {
  const userPath = await resolveUserPath()
  const { token } = readAuthStore()
  const env = {
    ...process.env,
    PATH: userPath,
    TERM: 'dumb',
    PS1: ''
  }
  if (token) {
    env.MAO_TOKEN = token
  } else {
    delete env.MAO_TOKEN
  }
  return env
}

/**
 * 持久 shell 会话的 env 在 spawn 后不会自动更新；每次执行命令前重新写入。
 * bash 用 export，PowerShell 用 $env:。
 */
function refreshMaoTokenInShellSession(session) {
  if (!session?.writeStdin) return
  const protocol = resolveShellProtocol()
  const { token } = readAuthStore()
  if (token) {
    session.writeStdin(protocol.envSet('MAO_TOKEN', token) + '\n')
  } else {
    session.writeStdin(protocol.envUnset('MAO_TOKEN') + '\n')
  }
}

function sendToRenderer(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data)
  }
}

function setUpdaterStatus(status, progressPercent = updaterProgressPercent) {
  updaterStatus = status
  updaterProgressPercent = progressPercent
  buildApplicationMenu()
}

function installDownloadedUpdate() {
  if (!updateDownloaded) {
    return { success: false, error: 'Update has not been downloaded yet.' }
  }
  // macOS 的 quitAndInstall 先关窗、后发 before-quit。默认「关窗收托盘」会在
  // quitting 仍为 false 时把 close 变成 hide，退出被取消，安装不会开始。
  quitting = true
  autoUpdater.quitAndInstall(false, true)
  return { success: true }
}

function showUpdateMessage(type, title, message, buttons = ['确定']) {
  const options = {
    type,
    title,
    message,
    buttons,
    defaultId: 0,
    cancelId: buttons.length - 1
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    return dialog.showMessageBox(mainWindow, options)
  }
  return dialog.showMessageBox(options)
}

async function showMenuUpdateCheckResult() {
  if (updateDownloaded) {
    const { response } = await showUpdateMessage(
      'info',
      '更新已就绪',
      '客户端新版本已下载完成，可以重启 Mao 完成安装。',
      ['重启完成更新', '稍后']
    )
    if (response === 0) installDownloadedUpdate()
    return
  }

  if (updaterStatus === 'available' || updaterStatus === 'downloading') {
    const progressLabel = updaterProgressPercent == null ? '' : `（${Math.round(updaterProgressPercent)}%）`
    await showUpdateMessage('info', '正在下载新版本', `已发现客户端新版本，正在后台下载${progressLabel}。`)
    return
  }

  if (updaterStatus === 'not-available') {
    await showUpdateMessage('info', '已是最新版本', `当前 Mao ${app.getVersion()} 已是最新版本。`)
    return
  }

  if (updaterStatus === 'unsupported') {
    await showUpdateMessage('warning', '无法检查更新', '自动更新仅在打包后的客户端中可用。')
  }
}

async function checkForAppUpdateFromMenu() {
  try {
    await checkForAppUpdate()
    await showMenuUpdateCheckResult()
  } catch (error) {
    const message = error?.message || '检查更新失败'
    console.error('[updater] menu check failed:', error)
    await showUpdateMessage('error', '检查更新失败', message)
  }
}

function buildUpdateMenuItem() {
  const isDownloading = updaterStatus === 'available' || updaterStatus === 'downloading'
  const progressLabel = updaterProgressPercent == null ? '' : ` ${Math.round(updaterProgressPercent)}%`

  if (updateDownloaded) {
    return {
      label: '重启完成更新',
      enabled: true,
      click: () => {
        installDownloadedUpdate()
      }
    }
  } else if (isDownloading) {
    return {
      label: `正在下载新版本${progressLabel}`,
      enabled: false
    }
  }

  return {
    label: updaterStatus === 'checking' ? '正在检查更新' : '检查更新',
    enabled: app.isPackaged && !updateCheckPromise,
    click: () => {
      checkForAppUpdateFromMenu()
    }
  }
}

function buildServerMenuItem() {
  return {
    label: '服务器设置…',
    click: () => openServerPickerWindow(),
  }
}

function buildApplicationMenu() {
  if (!app.isReady()) return

  const template = []

  if (process.platform === 'darwin') {
    template.push({
      label: 'Mao',
      submenu: [
        { role: 'about', label: '关于 Mao' },
        { type: 'separator' },
        buildServerMenuItem(),
        { type: 'separator' },
        buildUpdateMenuItem(),
        { type: 'separator' },
        { role: 'services', label: '服务' },
        { type: 'separator' },
        { role: 'hide', label: '隐藏 Mao' },
        { role: 'hideOthers', label: '隐藏其他' },
        { role: 'unhide', label: '全部显示' },
        { type: 'separator' },
        { role: 'quit', label: '退出 Mao' }
      ]
    })
  } else {
    template.push({
      label: 'Mao',
      submenu: [
        buildServerMenuItem(),
        { type: 'separator' },
        buildUpdateMenuItem(),
        { type: 'separator' },
        { role: 'quit', label: '退出 Mao' }
      ]
    })
  }

  template.push(
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '显示',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '切换全屏' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'close', label: '关闭' }
      ]
    }
  )

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function serializeUpdaterError(error) {
  if (!error) return { message: 'Unknown updater error' }
  return {
    message: error.message || String(error),
    stack: error.stack
  }
}

function getUpdateFeedUrlOverride() {
  return process.env.MAO_DESKTOP_UPDATE_URL || ''
}

function applyUpdateFeedUrl() {
  const feed = serverConfigLib.resolveUpdateFeedUrl(getServerConfig(), getUpdateFeedUrlOverride())
  if (!feed.url) return { mode: feed.mode, url: null }
  try {
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: feed.url,
    })
    return feed
  } catch (e) {
    console.warn('[updater] setFeedURL failed:', e?.message)
    return { mode: feed.mode, url: feed.url, error: e?.message }
  }
}

function setupAutoUpdater() {
  if (updaterInitialized) return
  updaterInitialized = true

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  applyUpdateFeedUrl()

  autoUpdater.on('checking-for-update', () => {
    setUpdaterStatus('checking', null)
    const feed = serverConfigLib.resolveUpdateFeedUrl(getServerConfig(), getUpdateFeedUrlOverride())
    sendToRenderer('update-checking', { feedUrl: feed.url || null })
  })

  autoUpdater.on('update-available', (info) => {
    updateDownloaded = false
    setUpdaterStatus('available', 0)
    sendToRenderer('update-available', info)
  })

  autoUpdater.on('update-not-available', (info) => {
    setUpdaterStatus('not-available', null)
    sendToRenderer('update-not-available', info)
  })

  autoUpdater.on('download-progress', (progress) => {
    setUpdaterStatus('downloading', Math.max(0, Math.min(100, progress?.percent || 0)))
    sendToRenderer('download-progress', progress)
  })

  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true
    setUpdaterStatus('downloaded', 100)
    sendToRenderer('update-downloaded', info)
  })

  autoUpdater.on('error', (error) => {
    console.error('[updater] error:', error)
    setUpdaterStatus('error', null)
    sendToRenderer('update-error', serializeUpdaterError(error))
  })
}

async function checkForAppUpdate() {
  if (!app.isPackaged) {
    setUpdaterStatus('unsupported', null)
    return { skipped: true, reason: 'Auto update is only available in packaged builds.' }
  }
  const feed = serverConfigLib.resolveUpdateFeedUrl(getServerConfig(), getUpdateFeedUrlOverride())
  if (feed.mode === 'disabled') {
    setUpdaterStatus('idle', null)
    return { skipped: true, reason: 'Auto update is disabled by server config.' }
  }
  setupAutoUpdater()
  applyUpdateFeedUrl()
  if (!updateCheckPromise) {
    setUpdaterStatus('checking', null)
    updateCheckPromise = autoUpdater.checkForUpdates()
      .then((result) => ({
        skipped: false,
        updateInfo: result?.updateInfo || null
      }))
      .catch((error) => {
        sendToRenderer('update-error', serializeUpdaterError(error))
        throw error
      })
      .finally(() => {
        updateCheckPromise = null
        buildApplicationMenu()
      })
  }
  return updateCheckPromise
}

function requestToolApproval(toolName, description, sessionId, dangerReason, backendRequestId, approvalHint) {
  return new Promise((resolve) => {
    const requestId = backendRequestId || `approval_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`

    pendingApprovals.set(requestId, (approved) => {
      pendingApprovals.delete(requestId)
      resolve(approved)
    })

    const payload = { requestId, toolName, description, sessionId }
    if (dangerReason) payload.dangerReason = dangerReason
    // 「总是允许」hint（V135）：服务端随 tool_execute 下发的模式提示，透传给渲染层审批卡片
    if (approvalHint) payload.approvalHint = approvalHint
    sendToRenderer('tool-approval-request', payload)
  })
}

/** Persist shell reuse / write_stdin must re-check approval — first approve must not unlock later commands. */
async function ensureShellApproval(needApproval, description, sessionId, dangerReason, backendRequestId, approvalHint) {
  if (!needApproval) return true
  return requestToolApproval('shell', description, sessionId, dangerReason, backendRequestId, approvalHint)
}

ipcMain.handle('tool-approval-response', (event, { requestId, approved }) => {
  const resolve = pendingApprovals.get(requestId)
  if (resolve) {
    pendingApprovals.delete(requestId)
    resolve(!!approved)
  }
  // alwaysAllow 由渲染层直接走 WS tool_approval 帧回服务端，主进程无需处理
})

// ========== Multi-server baseUrl config ==========

/** @type {{ config: any, fromFile: boolean } | null} */
let serverConfigCache = null
let serverPickerWindow = null

function getServerConfigStorePath() {
  return serverConfigLib.getServerConfigPath(app.getPath('userData'))
}

function loadServerConfig(force = false) {
  if (serverConfigCache && !force) return serverConfigCache
  serverConfigCache = serverConfigLib.readServerConfig(app.getPath('userData'))
  return serverConfigCache
}

function getServerConfig() {
  return loadServerConfig().config
}

function getServerBaseUrlEnvOverride() {
  return (process.env.MAO_DESKTOP_SERVER_URL || '').trim()
}

function getEffectiveServerBaseUrl() {
  const envBase = getServerBaseUrlEnvOverride()
  if (envBase) {
    const normalized = serverConfigLib.normalizeServerBaseUrl(envBase, { allowHttp: true })
    if (normalized.ok) return normalized.baseUrl
  }
  return getServerConfig().serverBaseUrl || serverConfigLib.DEFAULT_SERVER_BASE_URL
}

function isServerConfigured() {
  if (getServerBaseUrlEnvOverride()) return true
  return getServerConfig().configured === true
}

function getApiBaseUrl() {
  if (process.env.NODE_ENV === 'development' && !app.isPackaged) {
    return 'http://localhost:9080/api'
  }
  return serverConfigLib.deriveApiBase(getEffectiveServerBaseUrl())
}

function getServerHostKey() {
  return serverConfigLib.serverHostKey(getEffectiveServerBaseUrl())
}

function getServerPickerHtmlPath() {
  return path.join(__dirname, 'server-picker', 'index.html')
}

function loadServerPicker() {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.loadFile(getServerPickerHtmlPath())
}

const LOCAL_RUNTIME_ROOT = path.join(os.homedir(), '.mao', 'runtime')

function resolveLocalRuntimeDir(sessionId) {
  return path.join(LOCAL_RUNTIME_ROOT, getServerHostKey(), String(sessionId))
}

function resolveLocalSkillsDir(sessionId) {
  return path.join(resolveLocalRuntimeDir(sessionId), 'skills')
}

function resolveLocalShellOutputDir(sessionId) {
  return path.join(resolveLocalRuntimeDir(sessionId), 'shellOutput')
}

function formatLocalRuntimePath(sessionId, ...segments) {
  return ['~/.mao/runtime', getServerHostKey(), String(sessionId), ...segments].join('/')
}

const localShell = createLocalShellRuntime({
  buildEnv: buildShellEnv,
  refreshToken: refreshMaoTokenInShellSession,
  resolveOutput: (maoSessionId, shellId) => {
    const fileName = `${shellId}.out`
    return {
      absPath: path.join(resolveLocalShellOutputDir(maoSessionId || 0), fileName),
      displayPath: formatLocalRuntimePath(maoSessionId || 0, 'shellOutput', fileName),
    }
  },
})

function expandHomePath(filePath) {
  if (!filePath) return filePath
  if (filePath === '~') return os.homedir()
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2))
  return filePath
}

function isUnderLocalRuntime(absolutePath, maoSessionId) {
  if (!maoSessionId) return false
  const runtimeDir = resolveLocalRuntimeDir(maoSessionId)
  const resolved = path.resolve(absolutePath)
  return resolved === runtimeDir || resolved.startsWith(runtimeDir + path.sep)
}

// ========== Skill sync IPC handler ==========

function preferIpv4Loopback(url) {
  // Electron/undici 解析 localhost 会先走 ::1；TS 后端 listen 0.0.0.0 只收 IPv4。
  return String(url || '').replace('://localhost', '://127.0.0.1')
}

function resolveSkillSyncBaseUrl(apiBase) {
  const raw = typeof apiBase === 'string' && apiBase.trim() !== '' ? apiBase.trim() : getApiBaseUrl()
  return preferIpv4Loopback(raw.replace(/\/v1\/?$/, '').replace(/\/$/, ''))
}

ipcMain.handle('skill-sync', async (event, { sessionId, syncUrl, token, apiBase }) => {
  if (!sessionId) {
    const err = 'No sessionId provided for skill sync.'
    sendToRenderer('skill-sync-complete', { sessionId, success: false, error: err })
    return { success: false, error: err }
  }
  try {
    const AdmZip = require('adm-zip')
    const skillsDir = resolveLocalSkillsDir(sessionId)

    const origin = resolveSkillSyncBaseUrl(apiBase)
    const fullUrl = preferIpv4Loopback(/^https?:\/\//.test(syncUrl) ? syncUrl : `${origin}${syncUrl}`)
    const headers = token ? { 'Authorization': `Bearer ${token}` } : {}
    const response = await fetch(fullUrl, { method: 'POST', headers })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      throw new Error(`Skill sync download failed: ${response.status} ${response.statusText} - ${body}`)
    }

    const zipBuffer = Buffer.from(await response.arrayBuffer())
    fs.mkdirSync(skillsDir, { recursive: true })
    const zip = new AdmZip(zipBuffer)
    zip.extractAllTo(skillsDir, true)
    sendToRenderer('skill-sync-complete', { sessionId, success: true })
    return { success: true }
  } catch (e) {
    console.error('Skill sync failed:', e)
    sendToRenderer('skill-sync-complete', { sessionId, success: false, error: e.message })
    return { success: false, error: e.message }
  }
})

// ========== Local skills (~/.agents/skills) ==========

const LOCAL_SKILLS_DIR = path.join(os.homedir(), '.agents', 'skills')

function parseSkillMd(content) {
  if (!content || !content.startsWith('---')) return null
  const secondDelimiter = content.indexOf('---', 3)
  if (secondDelimiter === -1) return null

  const frontmatter = content.substring(3, secondDelimiter).trim()
  const body = content.substring(secondDelimiter + 3).trim()

  let name = null
  let description = null
  for (const line of frontmatter.split('\n')) {
    const nameMatch = line.match(/^name:\s*(.+)$/)
    if (nameMatch) {
      name = nameMatch[1].trim().replace(/^["']|["']$/g, '')
    }
    const descMatch = line.match(/^description:\s*(.+)$/)
    if (descMatch) {
      description = descMatch[1].trim().replace(/^["']|["']$/g, '')
    }
  }

  if (!name) return null
  return { name, description: description || '', body }
}

function resolveLocalSkillFolder(folderName) {
  if (!folderName || typeof folderName !== 'string') return null
  if (folderName.includes('/') || folderName.includes('\\') || folderName.startsWith('.')) {
    return null
  }
  const skillFolder = path.resolve(LOCAL_SKILLS_DIR, folderName)
  const normalizedRoot = path.resolve(LOCAL_SKILLS_DIR)
  if (skillFolder !== normalizedRoot && !skillFolder.startsWith(normalizedRoot + path.sep)) {
    return null
  }
  if (!fs.existsSync(skillFolder) || !fs.statSync(skillFolder).isDirectory()) {
    return null
  }
  return skillFolder
}

function collectSkillFiles(dir, baseDir, files = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      collectSkillFiles(fullPath, baseDir, files)
    } else if (entry.isFile()) {
      const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/')
      if (!relativePath || relativePath.includes('/.')) continue
      files.push({ relativePath, fullPath })
    }
  }
  return files
}

ipcMain.handle('list-local-skills', async () => {
  try {
    if (!fs.existsSync(LOCAL_SKILLS_DIR)) {
      return { skills: [], skillsDir: LOCAL_SKILLS_DIR }
    }

    const skills = []
    const entries = fs.readdirSync(LOCAL_SKILLS_DIR, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue

      const folderPath = path.join(LOCAL_SKILLS_DIR, entry.name)
      const skillMdPath = path.join(folderPath, 'SKILL.md')
      if (!fs.existsSync(skillMdPath)) continue

      try {
        const content = fs.readFileSync(skillMdPath, 'utf-8')
        const parsed = parseSkillMd(content)
        if (!parsed) continue
        skills.push({
          folderName: entry.name,
          name: parsed.name,
          description: parsed.description,
          folderPath,
        })
      } catch (e) {
        console.warn('[local-skills] Failed to parse:', entry.name, e.message)
      }
    }

    skills.sort((a, b) => a.name.localeCompare(b.name))
    return { skills, skillsDir: LOCAL_SKILLS_DIR }
  } catch (e) {
    console.error('[local-skills] list failed:', e)
    return { error: e.message, skills: [], skillsDir: LOCAL_SKILLS_DIR }
  }
})

ipcMain.handle('get-local-skill-detail', async (event, { folderName }) => {
  try {
    const skillFolder = resolveLocalSkillFolder(folderName)
    if (!skillFolder) {
      return { error: 'Skill not found: ' + folderName }
    }

    const skillMdPath = path.join(skillFolder, 'SKILL.md')
    const content = fs.readFileSync(skillMdPath, 'utf-8')
    const parsed = parseSkillMd(content)
    if (!parsed) {
      return { error: 'Invalid SKILL.md in skill: ' + folderName }
    }

    return {
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
      folderPath: skillFolder,
      filePath: skillMdPath,
      folderName,
    }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('read-local-skill-files', async (event, { folderName }) => {
  try {
    const skillFolder = resolveLocalSkillFolder(folderName)
    if (!skillFolder) {
      return { error: 'Skill not found: ' + folderName }
    }

    const fileEntries = collectSkillFiles(skillFolder, skillFolder)
    const files = fileEntries.map(({ relativePath, fullPath }) => ({
      relativePath,
      base64: fs.readFileSync(fullPath).toString('base64'),
    }))

    return { folderName, files }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('read-agents-md', async (event, { workspace }) => {
  try {
    if (!workspace) {
      return { content: null }
    }

    const agentsMdPath = path.join(workspace, 'AGENTS.md')
    if (!fs.existsSync(agentsMdPath)) {
      return { content: null }
    }

    const stat = fs.statSync(agentsMdPath)
    if (!stat.isFile()) {
      return { content: null }
    }

    const content = fs.readFileSync(agentsMdPath, 'utf-8')
    return { content: content || null }
  } catch (e) {
    console.error('[read-agents-md] Failed:', e.message)
    return { error: e.message, content: null }
  }
})

function resolveWorkspacePath(filePath, workspace, maoSessionId) {
  const effectiveWorkspace = workspace || currentWorkspace
  if (!filePath) return filePath

  const expanded = expandHomePath(filePath)
  if (path.isAbsolute(expanded)) {
    if (maoSessionId && isUnderLocalRuntime(expanded, maoSessionId)) {
      return expanded
    }
    return expanded
  }
  if (!effectiveWorkspace) return expanded
  return path.join(effectiveWorkspace, expanded)
}

function detectShell() {
  return process.env.SHELL || process.env.ComSpec || process.env.COMSPEC || (process.platform === 'win32' ? 'cmd.exe' : '/bin/sh')
}

function buildOsVersion() {
  if (process.platform === 'win32') {
    return `${os.version()} ${os.release()}`
  }
  return `${os.type()} ${os.release()}`
}

function isGitWorkspace(workspace) {
  if (!workspace) return false
  let current = path.resolve(workspace)
  while (current && current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) {
      return true
    }
    current = path.dirname(current)
  }
  return false
}

const { getGitStatus, refreshGitStatus, getGitFileDiff, listGitRepos, getGitLog, getGitCommitFiles, getGitCommitFileDiff, getGitBranchCompare, getGitBranchCompareFileDiff, getGitBranches, getGitStashes, getGitRemotes } = require('./gitStatus.cjs')
const { buildCommitInput, commit: gitCommit, pull: gitPull, push: gitPush, fetch: gitFetch, switchBranch: gitSwitchBranch, stashOp: gitStashOp } = require('./gitOperations.cjs')

function loadMainContent() {
  if (process.env.NODE_ENV === 'development' && !app.isPackaged) {
    mainWindow.loadURL('http://localhost:5201')
    mainWindow.webContents.openDevTools()
    return
  }

  // 生产：远程 SPA；未配置服务器时先展示本地配置页
  if (!isServerConfigured()) {
    loadServerPicker()
    return
  }

  const target = getEffectiveServerBaseUrl()
  mainWindow.loadURL(target).catch((err) => {
    console.error('[server] loadURL failed:', target, err)
    loadServerPicker()
  })
}

async function cleanupSiteScopedResources() {
  try {
    terminalManager.killAll()
  } catch (e) {
    console.warn('[server] terminal cleanup failed:', e?.message)
  }
  try {
    localShell.closeAll()
  } catch (e) {
    console.warn('[server] local shell cleanup failed:', e?.message)
  }
  const sessionIds = Array.from(mcpClients.keys())
  await Promise.all(
    sessionIds.map((sid) =>
      closeMcpSession(sid).catch((e) => console.warn('[server] mcp cleanup failed:', e?.message))
    )
  )
}

/**
 * 切换服务器：校验 → 可选探测 → host 变化时清 auth/本地资源 → 写配置 → 加载目标站。
 * @param {{ serverBaseUrl: string, updateFeedMode?: string, allowHttp?: boolean, skipProbe?: boolean }} payload
 */
async function applyServerConfig(payload = {}) {
  const allowHttp = payload.allowHttp === true
  const normalized = serverConfigLib.normalizeServerBaseUrl(payload.serverBaseUrl, { allowHttp })
  if (!normalized.ok) {
    return { ok: false, error: normalized.error }
  }

  const targetBase = normalized.baseUrl
  const previousBase = getEffectiveServerBaseUrl()
  const previousHost = serverConfigLib.serverHostKey(previousBase)
  const nextHost = serverConfigLib.serverHostKey(targetBase)
  const hostChanged = previousHost !== nextHost

  if (payload.skipProbe !== true) {
    const probe = await serverConfigLib.probeServer(targetBase)
    if (!probe.ok) {
      return { ok: false, error: probe.error || '服务器检测失败', probe }
    }
  }

  if (hostChanged) {
    writeAuthStore({ token: null, refreshToken: null })
    await cleanupSiteScopedResources()
  }

  const writeResult = serverConfigLib.writeServerConfig(app.getPath('userData'), {
    serverBaseUrl: targetBase,
    updateFeedMode: payload.updateFeedMode || getServerConfig().updateFeedMode || 'follow-site',
    allowHttp,
    configured: true,
  })
  if (!writeResult.ok) {
    return { ok: false, error: writeResult.error }
  }

  serverConfigCache = null
  loadServerConfig(true)

  // 更新源跟随站点时重新绑定 feed
  const feed = serverConfigLib.resolveUpdateFeedUrl(getServerConfig(), getUpdateFeedUrlOverride())
  if (feed.url) {
    try {
      autoUpdater.setFeedURL({ provider: 'generic', url: feed.url })
    } catch (e) {
      console.warn('[updater] setFeedURL failed:', e?.message)
    }
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    loadMainContent()
  }
  return {
    ok: true,
    serverBaseUrl: targetBase,
    hostChanged,
    updateFeedMode: writeResult.config.updateFeedMode,
  }
}

function openServerPickerWindow() {
  if (serverPickerWindow && !serverPickerWindow.isDestroyed()) {
    serverPickerWindow.focus()
    return
  }
  serverPickerWindow = new BrowserWindow({
    width: 480,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Mao · 服务器设置',
    parent: mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined,
    modal: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  serverPickerWindow.loadFile(getServerPickerHtmlPath())
  serverPickerWindow.on('closed', () => {
    serverPickerWindow = null
  })
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    title: 'Mao',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 12 },
    backgroundColor: '#f5f5f7',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
    }
  })

  loadMainContent()

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // 关窗拦截（P2，默认托盘化）：quitting 旗标未置位且偏好为托盘时，红点/X/窗口菜单「关闭」
  // 一律 hide 而非销毁——渲染层与 WS 存活，任务继续跑、通知照常可达。
  // 退出路径（托盘菜单 / 应用菜单 role:quit / app.quit()）都先走 before-quit 置
  // quitting=true，本拦截随之失效，窗口正常关闭并全量清理。
  mainWindow.on('close', (e) => {
    if (quitting) return
    const prefs = desktopPrefsLib.readDesktopPrefs(app.getPath('userData'))
    if (prefs.closeToTray !== 'tray') return
    e.preventDefault()
    mainWindow.hide()
    if (!prefs.trayHintShown) {
      sendToRenderer('tray-first-close-hint', {})
      desktopPrefsLib.writeDesktopPrefs(app.getPath('userData'), { trayHintShown: true })
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 托盘菜单文案（显示/隐藏主窗）随窗口显示态刷新。挂在 createWindow 里而非 initTray：
  // 退出模式下关窗会销毁窗口，activate/second-instance 重建的新窗口同样需要这些监听，
  // 否则文案停留在旧状态，用户按文案点击会做出与意图相反的动作。
  // closed 也必须监听：退出模式关窗走销毁，此时 isWindowVisible() 因 mainWindow 置 null
  // 返回 false，文案应翻为「显示主窗」（点击即重建），停在「隐藏主窗」会语义相反。
  const refreshTray = () => appTray?.refresh()
  mainWindow.on('show', refreshTray)
  mainWindow.on('hide', refreshTray)
  mainWindow.on('minimize', refreshTray)
  mainWindow.on('restore', refreshTray)
  mainWindow.on('closed', refreshTray)

  // 返回实例：调用方（second-instance / 通知 click 重建路径）需要拿到它来
  // restore/show/focus 或挂加载回调，不能只靠 ready-to-show 兜底
  return mainWindow
}

// ========== P2/P3 桌面壳：托盘 / 通知 / 角标 / 偏好 / 快捷键 ==========

function readDesktopPrefs() {
  return desktopPrefsLib.readDesktopPrefs(app.getPath('userData'))
}

function initTray() {
  if (appTray) return
  appTray = createTray({
    isWindowVisible: () => !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible(),
    onShowHide: () => {
      const win = mainWindow
      if (!win || win.isDestroyed()) {
        createWindow()
        return
      }
      if (win.isVisible()) {
        win.hide()
      } else {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
      appTray?.refresh()
    },
    onNewTask: () => {
      // 渲染层复用「新建任务」既有入口（Home + newTask=1）；窗口不可见时先唤起
      const win = mainWindow
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
      sendToRenderer('tray-new-task', {})
    },
    onQuit: () => {
      // before-quit 置 quitting → close 不再拦截 → 全量清理后退出
      app.quit()
    },
  })
}

/**
 * 全局快捷键（P3，默认 Alt+Shift+M，可改可关）：触发时窗口可见且聚焦则隐藏，否则唤起。
 * 换键顺序必须是「先注册新键、成功后再摘旧键」：反过来会在新键注册失败时把旧键也弄丢
 * （unregisterAll 先清空），而偏好文件与设置页仍显示旧键，快捷键静默失效到重启。
 * @param {string | null} accel
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function applyGlobalShortcut(accel) {
  if (!accel) {
    // 关闭：只摘当前已注册的那个键，不影响（也不存在的）其他注册项
    try {
      if (currentShortcutAccel) globalShortcut.unregister(currentShortcutAccel)
    } catch (e) {
      console.warn('[shortcut] unregister failed:', e?.message)
    }
    currentShortcutAccel = null
    return { ok: true }
  }
  // 与当前键相同：直接视为成功。Electron 对「重复注册同一 accelerator」的返回值有版本
  // 差异，早退可消掉这层不确定，也避免误导性的「被其他程序占用」提示
  if (currentShortcutAccel === accel) return { ok: true }
  try {
    const registered = globalShortcut.register(accel, () => {
      const win = mainWindow
      // 无窗口（退出模式关窗销毁后应用仍驻留）时重建：快捷键语义是「否则唤起」，
      // 直接 return 会让仍显示「已启用」的快捷键完全失效
      if (!win || win.isDestroyed()) {
        createWindow()
        appTray?.refresh()
        return
      }
      if (win.isVisible() && !win.isMinimized() && win.isFocused()) {
        win.hide()
      } else {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
      }
      appTray?.refresh()
    })
    if (!registered) {
      // 新键没注册上：旧键原样保持生效，偏好不写，UI 与实际状态一致
      return { ok: false, error: '快捷键注册失败，可能已被其他程序占用' }
    }
    if (currentShortcutAccel && currentShortcutAccel !== accel) {
      try {
        globalShortcut.unregister(currentShortcutAccel)
      } catch (e) {
        console.warn('[shortcut] unregister old accel failed:', e?.message)
      }
    }
    currentShortcutAccel = accel
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `快捷键格式无效：${e?.message || ''}` }
  }
}

/**
 * 开机自启（P3）：仅打包后客户端可写登录项（防 dev 的 electron 二进制误入登录项，决策 8）。
 * openAsHidden 配合托盘模式：自启后驻留托盘不弹窗。
 */
function applyAutoStart(enabled) {
  if (!app.isPackaged) {
    return { ok: false, error: '开发模式下不支持开机自启，请使用打包后的客户端' }
  }
  try {
    app.setLoginItemSettings({ openAtLogin: enabled === true, openAsHidden: true })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: `设置开机自启失败：${e?.message || ''}` }
  }
}

ipcMain.handle('local-copy-attachment', async (event, payload) => {
  // 落点由主进程推导（home + server host + sessionId），渲染层无法指定。
  // 异步拷贝：大文件的 copyFile 不阻塞主进程事件循环（曾用同步 copyFileSync，
  // 拖入接近上限的大附件会把整个应用卡死数十秒）。
  return chatAttachment.copyLocalAttachmentAsync({
    sourcePath: payload?.sourcePath,
    sessionId: payload?.sessionId,
    maxSizeMb: payload?.maxSizeMb,
    homeDir: os.homedir(),
    hostKey: getServerHostKey(),
  })
})

ipcMain.handle('local-write-text-file', async (event, payload) => {
  // 备用入口（渲染层直接写本机文本；粘贴转出的附件也走这里）：同名避重，不覆盖已有附件。
  return handleLocalWriteTextFile(payload, payload?.sessionId, true)
})

ipcMain.handle('desktop-notify', (event, payload) => {
  const title = String(payload?.title ?? '')
  const body = String(payload?.body ?? '')
  const tag = payload?.tag != null ? String(payload.tag) : undefined
  const itemId = payload?.itemId ?? null
  const sessionId = payload?.sessionId ?? null
  if (!title) return { ok: false, error: '通知标题为空' }
  try {
    const notification = new Notification({ title, body, tag })
    notification.on('click', () => {
      // 窗口隐藏到托盘时点击通知先唤起主窗，再把跳转事件交给渲染层。
      // 窗口已销毁（退出模式 + macOS 关窗后点旧通知）时重建：否则 sendToRenderer
      // 因 mainWindow 为 null 静默丢弃，用户点了通知却什么都没有。
      // 无论走哪条路径都先入待派发队列：渲染层监听可能尚未注册（应用刚启动、
      // 页面加载中、重建窗口的渲染进程是新的），立即 send 会丢，由渲染层桥接
      // 就绪后主动 consume 兜底；did-finish-load 补发仅在尚未被拉取时执行。
      const clickPayload = { itemId, sessionId }
      pendingNotificationClick = clickPayload
      const win = mainWindow
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
        sendToRenderer('desktop-notification-click', clickPayload)
        return
      }
      const created = createWindow()
      // 新窗口的渲染层（Vue 应用 + ipcRenderer.on）要等页面加载完才就绪：同步发
      // 跳转事件会丢（窗口能出来但不跳会话），等 did-finish-load 再补发。
      // 读队列与 send 同步完成，与 consume 不会交错：已被渲染层拉取时队列已空，跳过。
      if (created && !created.isDestroyed() && created.webContents) {
        created.webContents.once('did-finish-load', () => {
          const pending = pendingNotificationClick
          if (!pending) return
          sendToRenderer('desktop-notification-click', pending)
        })
      }
    })
    notification.on('failed', () => {
      console.warn('[notify] display failed:', title)
      sendToRenderer('desktop-notify-result', { ok: false, error: '系统通知展示失败', tag })
    })
    notification.show()
    return { ok: true }
  } catch (e) {
    const error = e?.message || '通知发送失败'
    sendToRenderer('desktop-notify-result', { ok: false, error, tag })
    return { ok: false, error }
  }
})

ipcMain.handle('desktop-notification-click-consume', () => {
  // 渲染层桥接就绪后主动拉取：点击时监听尚未注册（应用刚启动/页面加载中/窗口
  // 重建）导致的丢失由这里兜底。取出即清空——拉取过的点击不重复派发。
  const payload = pendingNotificationClick
  pendingNotificationClick = null
  return payload
})

ipcMain.handle('desktop-notification-click-ack', () => {
  // 渲染层已收到立即派发的点击深链：清除待派发队列，防止页面重载后
  // 桥接重新就绪时拿陈旧点击重复跳转。
  pendingNotificationClick = null
  return { ok: true }
})

ipcMain.handle('desktop-badge', (event, payload) => {
  const count = Math.max(0, Math.floor(Number(payload?.count) || 0))
  if (process.platform === 'darwin' && app.dock && typeof app.dock.setBadgeCount === 'function') {
    app.dock.setBadgeCount(count)
  }
  // win/linux no-op（overlay 角标列为后续可选）
  return { ok: true }
})

ipcMain.handle('desktop-prefs-get', () => {
  return { ok: true, prefs: readDesktopPrefs(), packaged: app.isPackaged, platform: process.platform }
})

ipcMain.handle('desktop-prefs-set', (event, patch) => {
  const next = patch && typeof patch === 'object' ? patch : {}
  // dev 模式禁止开启自启：直接拒绝，不落盘（防打包前的误开启在打包后生效）
  if (next.autoStart === true && !app.isPackaged) {
    return { ok: false, error: '开发模式下不支持开机自启，请使用打包后的客户端' }
  }
  const result = desktopPrefsLib.writeDesktopPrefs(app.getPath('userData'), next)
  let sideError = null
  if ('autoStart' in next) {
    const applied = applyAutoStart(result.prefs.autoStart)
    if (!applied.ok) sideError = applied.error
  }
  return { ok: true, prefs: result.prefs, error: sideError || undefined }
})

ipcMain.handle('desktop-shortcut-set', (event, accel) => {
  const next = accel == null ? null : String(accel).trim()
  if (next === '') {
    return { ok: false, error: '快捷键不能为空（关闭请传 null）' }
  }
  const applied = applyGlobalShortcut(next)
  if (!applied.ok) {
    sendToRenderer('desktop-shortcut-failed', { accel: next, error: applied.error })
    return { ok: false, error: applied.error }
  }
  const result = desktopPrefsLib.writeDesktopPrefs(app.getPath('userData'), { globalShortcut: next })
  return { ok: true, prefs: result.prefs }
})

app.whenReady().then(() => {
  buildApplicationMenu()
  createWindow()
  initTray()
  // 快捷键按偏好注册（默认 Alt+Shift+M）；失败时回传提示
  const shortcut = readDesktopPrefs().globalShortcut
  const registered = applyGlobalShortcut(shortcut)
  if (!registered.ok) {
    sendToRenderer('desktop-shortcut-failed', { accel: shortcut, error: registered.error })
  }
  if (app.isPackaged) {
    setTimeout(() => {
      checkForAppUpdate().catch((error) => {
        console.error('[updater] initial check failed:', error)
      })
    }, 3000)
  }
})

app.on('window-all-closed', () => {
  // 托盘模式下窗口是 hide 而非 close，不会触发本事件；仅「退出模式」下走原逻辑
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    // 托盘化后红点关闭 = 隐藏：dock 点击应恢复而非新建窗口
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    appTray?.refresh()
  }
})

app.on('before-quit', () => {
  quitting = true
  // 快捷键全部注销后同步清掉跟踪值：否则退出若被中止，之后「重设同一个键」会命中
  // 同键早退而跳过 register，键保持未注册但 UI/偏好显示已启用
  currentShortcutAccel = null
  try {
    globalShortcut.unregisterAll()
  } catch (e) {
    console.warn('[shortcut] unregisterAll on quit failed:', e?.message)
  }
  terminalManager.killAll()
  localShell.closeAll()
  localShell.stopCleanup()
  // 关闭全部 MCP 连接（stdio 子进程 / HTTP 会话）
  const sessionIds = Array.from(mcpClients.keys())
  sessionIds.forEach((sid) => {
    closeMcpSession(sid).catch((e) => console.warn('[mcp] quit cleanup failed:', e.message))
  })
})

// ========== Auth token persistence (file:// localStorage is not reliable) ==========

function getAuthStorePath() {
  return path.join(app.getPath('userData'), 'auth.json')
}

function readAuthStore() {
  try {
    const authPath = getAuthStorePath()
    if (fs.existsSync(authPath)) {
      const data = JSON.parse(fs.readFileSync(authPath, 'utf8'))
      // 服务端 host 变化后旧 token 不可用，避免串站
      const currentHost = getServerHostKey()
      if (data.serverHost && data.serverHost !== currentHost) {
        return { token: null, refreshToken: null }
      }
      return {
        token: data.token || null,
        refreshToken: data.refreshToken || null
      }
    }
  } catch (e) {
    console.error('[auth] Failed to read auth store:', e.message)
  }
  return { token: null, refreshToken: null }
}

function writeAuthStore(data) {
  try {
    const authPath = getAuthStorePath()
    fs.mkdirSync(path.dirname(authPath), { recursive: true })
    const payload = {
      token: data.token || null,
      refreshToken: data.refreshToken || null,
      serverHost: data.token || data.refreshToken ? getServerHostKey() : null,
    }
    fs.writeFileSync(authPath, JSON.stringify(payload), 'utf8')
  } catch (e) {
    console.error('[auth] Failed to write auth store:', e.message)
  }
}

ipcMain.handle('auth-get-tokens', () => readAuthStore())

ipcMain.handle('auth-set-tokens', (_event, { token, refreshToken }) => {
  writeAuthStore({ token: token || null, refreshToken: refreshToken || null })
})

ipcMain.handle('auth-clear-tokens', () => {
  writeAuthStore({ token: null, refreshToken: null })
})

// ========== Server baseUrl config IPC ==========

ipcMain.handle('server-config-get', () => {
  const config = getServerConfig()
  const envOverride = getServerBaseUrlEnvOverride()
  const feed = serverConfigLib.resolveUpdateFeedUrl(config, getUpdateFeedUrlOverride())
  return {
    serverBaseUrl: getEffectiveServerBaseUrl(),
    updateFeedMode: config.updateFeedMode || 'follow-site',
    allowHttp: config.allowHttp === true,
    configured: isServerConfigured(),
    envOverride: Boolean(envOverride),
    appVersion: app.getVersion(),
    hostKey: getServerHostKey(),
    apiBase: getApiBaseUrl(),
    updateFeed: feed,
  }
})

ipcMain.handle('server-config-probe', async (_event, payload = {}) => {
  const allowHttp = payload.allowHttp === true
  const normalized = serverConfigLib.normalizeServerBaseUrl(payload.serverBaseUrl, { allowHttp })
  if (!normalized.ok) return { ok: false, error: normalized.error }
  return serverConfigLib.probeServer(normalized.baseUrl)
})

ipcMain.handle('server-config-set', async (_event, payload = {}) => {
  return applyServerConfig(payload || {})
})

ipcMain.handle('server-config-open-picker', () => {
  openServerPickerWindow()
  return { ok: true }
})

// ========== Window control IPC handlers ==========

ipcMain.handle('window-minimize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.minimize()
  }
})

ipcMain.handle('window-maximize', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
  }
})

ipcMain.handle('window-close', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close()
  }
})

// ========== Original IPC handlers ==========

ipcMain.handle('get-app-version', () => {
  return app.getVersion()
})

ipcMain.handle('get-platform', () => {
  return process.platform
})

ipcMain.handle('check-for-update', () => {
  return checkForAppUpdate()
})

ipcMain.handle('install-update', () => {
  return installDownloadedUpdate()
})

ipcMain.handle('get-environment-info', (event, { workspace } = {}) => {
  return {
    isGit: isGitWorkspace(workspace || currentWorkspace),
    platform: process.platform,
    shell: detectShell(),
    osVersion: buildOsVersion()
  }
})

ipcMain.handle('git-repos', async (event, { workspace } = {}) => {
  try {
    return await listGitRepos(workspace || currentWorkspace)
  } catch (e) {
    return { isRootGit: false, repos: [], error: e.message || '扫描 Git 仓库失败' }
  }
})

ipcMain.handle('git-status', async (event, { workspace, repoPath } = {}) => {
  try {
    return await getGitStatus(workspace || currentWorkspace, repoPath)
  } catch (e) {
    return { isGit: false, remoteStatusAvailable: false, error: e.message || '读取 Git 状态失败' }
  }
})

ipcMain.handle('git-status-refresh', async (event, { workspace, repoPath } = {}) => {
  try {
    return await refreshGitStatus(workspace || currentWorkspace, repoPath)
  } catch (e) {
    return { isGit: false, remoteStatusAvailable: false, error: e.message || '刷新 Git 状态失败' }
  }
})

ipcMain.handle('git-file-diff', async (event, { workspace, repoPath, path: filePath } = {}) => {
  try {
    return await getGitFileDiff(workspace || currentWorkspace, repoPath, filePath)
  } catch (e) {
    return {
      path: filePath || '',
      changeType: 'MODIFIED',
      beforeContent: '',
      afterContent: '',
      unavailableReason: e.message || '读取 Git diff 失败',
    }
  }
})

ipcMain.handle('git-commit-input', async (_event, { workspace, repoPath } = {}) => {
  return buildCommitInput(workspace || currentWorkspace, repoPath)
})

ipcMain.handle('git-commit', async (_event, { workspace, repoPath, message } = {}) => {
  return gitCommit(workspace || currentWorkspace, repoPath, message)
})

ipcMain.handle('git-pull', async (_event, { workspace, repoPath } = {}) => {
  return gitPull(workspace || currentWorkspace, repoPath)
})

ipcMain.handle('git-push', async (_event, { workspace, repoPath } = {}) => {
  return gitPush(workspace || currentWorkspace, repoPath)
})

ipcMain.handle('git-log', async (_event, { workspace, repoPath, options } = {}) => {
  try {
    return await getGitLog(workspace || currentWorkspace, repoPath, options || {})
  } catch (e) {
    return { error: e.message || '读取提交历史失败' }
  }
})

ipcMain.handle('git-commit-files', async (_event, { workspace, repoPath, hash } = {}) => {
  try {
    return await getGitCommitFiles(workspace || currentWorkspace, repoPath, hash)
  } catch (e) {
    return { error: e.message || '读取提交文件清单失败' }
  }
})

ipcMain.handle('git-commit-file-diff', async (_event, { workspace, repoPath, hash, path: filePath, oldPath } = {}) => {
  try {
    return await getGitCommitFileDiff(workspace || currentWorkspace, repoPath, hash, filePath, oldPath)
  } catch (e) {
    return {
      path: filePath || '',
      changeType: 'MODIFIED',
      beforeContent: '',
      afterContent: '',
      unavailableReason: e.message || '读取提交 diff 失败',
    }
  }
})

// 分支对比：失败形状同 git-commit-files（对象形态的 { error }，由 provider 侧解包后抛错），
// 因为「ref 不存在 / 无共同祖先 / 对比失败」都必须与「两分支无差异（files: []）」可区分
ipcMain.handle('git-branch-compare', async (_event, { workspace, repoPath, base, target } = {}) => {
  try {
    return await getGitBranchCompare(workspace || currentWorkspace, repoPath, base, target)
  } catch (e) {
    return { error: e.message || '读取分支对比失败' }
  }
})

// 分支对比单文件 diff：失败形状同 git-commit-file-diff（降级 diff 对象，不抛）
ipcMain.handle('git-branch-compare-file-diff', async (_event, { workspace, repoPath, base, target, path: filePath, oldPath } = {}) => {
  try {
    return await getGitBranchCompareFileDiff(workspace || currentWorkspace, repoPath, base, target, filePath, oldPath)
  } catch (e) {
    return {
      path: filePath || '',
      changeType: 'MODIFIED',
      beforeContent: '',
      afterContent: '',
      unavailableReason: e.message || '读取分支 diff 失败',
    }
  }
})

ipcMain.handle('git-branches', async (_event, { workspace, repoPath } = {}) => {
  try {
    return await getGitBranches(workspace || currentWorkspace, repoPath)
  } catch (e) {
    return { error: e.message || '读取分支列表失败' }
  }
})

ipcMain.handle('git-stashes', async (_event, { workspace, repoPath } = {}) => {
  try {
    return await getGitStashes(workspace || currentWorkspace, repoPath)
  } catch (e) {
    return { error: e.message || '读取 stash 列表失败' }
  }
})

ipcMain.handle('git-remotes', async (_event, { workspace, repoPath } = {}) => {
  try {
    return await getGitRemotes(workspace || currentWorkspace, repoPath)
  } catch (e) {
    return { error: e.message || '读取远端列表失败' }
  }
})

ipcMain.handle('git-fetch', async (_event, { workspace, repoPath } = {}) => {
  return gitFetch(workspace || currentWorkspace, repoPath)
})

ipcMain.handle('git-switch-branch', async (_event, { workspace, repoPath, branch, create } = {}) => {
  return gitSwitchBranch(workspace || currentWorkspace, repoPath, branch, create === true)
})

ipcMain.handle('git-stash-op', async (_event, { workspace, repoPath, action, ref } = {}) => {
  return gitStashOp(workspace || currentWorkspace, repoPath, action, ref)
})

ipcMain.handle('open-external', async (event, url) => {
  if (typeof url !== 'string' || !url.trim()) {
    throw new Error('URL is required')
  }
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Unsupported external URL protocol')
  }
  await shell.openExternal(parsed.toString())
})

ipcMain.handle('open-feishu-auth-window', async (event, payload) => {
  const authUrl = typeof payload === 'string' ? payload : payload?.authUrl
  const callbackPath = typeof payload === 'object' && payload?.callbackPath
    ? payload.callbackPath
    : '/api/v1/auth/feishu/callback'
  return new Promise((resolve) => {
    const authWindow = new BrowserWindow({
      width: 800,
      height: 700,
      title: '飞书登录',
      autoHideMenuBar: true,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })

    authWindow.loadURL(authUrl)

    let resolved = false

    function checkUrl(url) {
      if (resolved) return
      try {
        const parsed = new URL(url)
        if (parsed.pathname === callbackPath || parsed.pathname.endsWith(callbackPath)) {
          resolved = true
          const state = parsed.searchParams.get('state') || ''
          const code = parsed.searchParams.get('code') || ''
          if (!authWindow.isDestroyed()) {
            authWindow.close()
          }
          resolve({ state, code })
        }
      } catch {
        // ignore invalid URLs
      }
    }

    authWindow.webContents.on('did-navigate', (_, url) => checkUrl(url))
    authWindow.webContents.on('did-navigate-in-page', (_, url) => checkUrl(url))

    authWindow.on('closed', () => {
      if (!resolved) {
        resolved = true
        resolve({ state: '' })
      }
    })
  })
})

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: '选择工作目录'
  })
  if (result.canceled || result.filePaths.length === 0) {
    return null
  }
  return result.filePaths[0]
})

ipcMain.handle('open-folder', (event, folderPath) => {
  if (folderPath) shell.openPath(folderPath)
})

ipcMain.handle('show-item-in-folder', (event, fullPath) => {
  if (fullPath) shell.showItemInFolder(fullPath)
})

ipcMain.handle('open-terminal', (event, folderPath) => {
  if (!folderPath) return
  spawn('open', ['-a', 'Terminal', folderPath], { detached: true, stdio: 'ignore' }).unref()
})

// ========== Terminal IPC handlers (node-pty) ==========

ipcMain.handle('terminal:create', async (event, options) => {
  const result = await terminalManager.create(options)
  const session = terminalManager.sessions.get(result.id)

  session.pty.onData((data) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:data', { id: result.id, data })
    }
  })

  session.pty.onExit(({ exitCode }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('terminal:exit', { id: result.id, exitCode })
    }
    terminalManager.sessions.delete(result.id)
  })

  return result
})

ipcMain.on('terminal:data', (event, { id, data }) => {
  terminalManager.write(id, data)
})

ipcMain.on('terminal:resize', (event, { id, cols, rows }) => {
  terminalManager.resize(id, cols, rows)
})

ipcMain.handle('terminal:kill', (event, { id }) => {
  terminalManager.kill(id)
})

ipcMain.handle('terminal:list', () => {
  return terminalManager.list()
})

// ========== Local tool execution IPC handlers ==========

ipcMain.handle('local-read-file', async (event, { path: filePath, offset, limit }) => {
  try {
    const resolvedPath = resolveWorkspacePath(filePath)
    if (mimeFromPath(filePath)) {
      return readLocalImage(resolvedPath, filePath)
    }
    if (filePath.toLowerCase().endsWith('.pdf')) {
      // PDF 预览：按字节读取并以 base64 data_uri 返回，由渲染进程转为 Blob 交给 pdf.js
      const buffer = fs.readFileSync(resolvedPath)
      return {
        content: `PDF 文件：${filePath}`,
        total_lines: 0,
        media_type: 'pdf',
        mime: 'application/pdf',
        data_uri: `data:application/pdf;base64,${buffer.toString('base64')}`,
      }
    }
    const content = fs.readFileSync(resolvedPath, 'utf-8')
    const lines = content.split('\n')
    const totalLines = lines.length
    const start = offset || 0
    const end = limit ? Math.min(start + limit, totalLines) : totalLines
    const sliced = lines.slice(start, end).join('\n')
    return { content: sliced, total_lines: totalLines }
  } catch (e) {
    return { error: e.message }
  }
})

// LOCAL 二进制字节读取（技术方案 §5.2）：zip / xlsx / docx / 媒体预览的取数通道。
// 路径解析与 local-read-file 共用 resolveWorkspacePath；类型校验与大小上限在
// localFileBytes.cjs（可单测）。文件全程不出本机，无任何上传语义。
ipcMain.handle('local-read-bytes', async (event, { path: filePath }) => {
  try {
    const resolvedPath = resolveWorkspacePath(filePath)
    return readFileBytes(resolvedPath)
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('local-write-file', async (event, { path: filePath, content }) => {
  const approved = await requestToolApproval('write_file', filePath)
  if (!approved) {
    return { success: false, error: 'User denied file write.' }
  }
  try {
    const resolvedPath = resolveWorkspacePath(filePath)
    const fileExisted = fs.existsSync(resolvedPath)
    const beforeContent = fileExisted ? fs.readFileSync(resolvedPath, 'utf-8') : ''
    const dir = path.dirname(resolvedPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(resolvedPath, content, 'utf-8')
    const linesAdded = content.length === 0 ? 0 : content.split('\n').length
    const lineDelta = fileExisted
      ? computeLineDelta(beforeContent, content)
      : { linesAdded, linesDeleted: 0 }
    return {
      success: true,
      bytes_written: Buffer.byteLength(content, 'utf-8'),
      file_change: {
        path: filePath,
        type: fileExisted ? 'MODIFIED' : 'CREATED',
        lines_added: lineDelta.linesAdded,
        lines_deleted: lineDelta.linesDeleted
      },
      [PRIVATE_DIFF_FIELD]: buildFileChangeDiff(filePath, beforeContent, content)
    }
  } catch (e) {
    return { error: e.message }
  }
})

ipcMain.handle('local-edit-file', async (event, { path: filePath, old_string, new_string, replace_all }) => {
  const approved = await requestToolApproval('edit_file', filePath)
  if (!approved) {
    return { success: false, error: 'User denied file edit.' }
  }
  try {
    return writeEditedFile(
      resolveWorkspacePath(filePath),
      filePath,
      old_string,
      new_string,
      asBoolArg(replace_all),
    )
  } catch (e) {
    return { error: e.message }
  }
})

const IGNORED_DIRS = new Set(['node_modules', '__pycache__', '.git', 'target', 'dist', 'build', '.next', '.nuxt', '.venv', 'venv', '.idea', '.vscode'])

ipcMain.handle('list-workspace-files', async (event, { workspace, filter, limit }) => {
  try {
    if (!workspace || !fs.existsSync(workspace)) return []
    const maxResults = limit || 20
    const results = []

    function walkDir(dir, relativeBase) {
      if (results.length >= maxResults) return
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      // Sort entries: files first, then dirs, alphabetically
      entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? 1 : -1
        return a.name.localeCompare(b.name)
      })
      for (const entry of entries) {
        if (results.length >= maxResults) return
        if (entry.name.startsWith('.')) continue
        if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue
        const fullPath = path.join(dir, entry.name)
        const relPath = relativeBase ? relativeBase + '/' + entry.name : entry.name
        if (entry.isDirectory()) {
          walkDir(fullPath, relPath)
        } else {
          try {
            const stat = fs.statSync(fullPath)
            if (!filter || entry.name.toLowerCase().includes(filter.toLowerCase()) || relPath.toLowerCase().includes(filter.toLowerCase())) {
              results.push({ path: relPath, name: entry.name, size: stat.size, mtime: stat.mtimeMs })
            }
          } catch {
            // skip files we can't stat
          }
        }
      }
    }

    walkDir(workspace, '')
    // Sort by modification time descending
    results.sort((a, b) => b.mtime - a.mtime)
    // Remove mtime from response
    return results.map(({ mtime, ...rest }) => rest)
  } catch (e) {
    return []
  }
})

ipcMain.handle('list-directory', async (event, { dirPath, workspace }) => {
  try {
    if (!dirPath || !workspace) return { error: 'Missing dirPath or workspace' }
    const resolvedDir = path.resolve(dirPath)
    const resolvedWorkspace = path.resolve(workspace)
    if (!resolvedDir.startsWith(resolvedWorkspace + path.sep) && resolvedDir !== resolvedWorkspace) {
      return { error: 'Access denied: path outside workspace' }
    }
    if (!fs.existsSync(resolvedDir)) return { error: 'Directory does not exist' }

    const entries = fs.readdirSync(resolvedDir, { withFileTypes: true })
    const results = []
    const MAX_ENTRIES = 500

    for (const entry of entries) {
      if (results.length >= MAX_ENTRIES) break

      const fullPath = path.join(resolvedDir, entry.name)
      const relPath = path.relative(resolvedWorkspace, fullPath)
      let isSymlink = false
      let size = 0
      let mtime = 0

      try {
        const lstat = fs.lstatSync(fullPath)
        isSymlink = lstat.isSymbolicLink()
        size = lstat.size
        mtime = lstat.mtimeMs
      } catch {
        // skip entries we can't stat
        continue
      }

      results.push({
        name: entry.name,
        path: relPath,
        isDirectory: entry.isDirectory() && !isSymlink,
        size,
        mtime,
        isSymlink
      })
    }

    // Sort: folders first alphabetically, then files alphabetically
    results.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
      return a.name.localeCompare(b.name)
    })

    return { entries: results, truncated: entries.length > MAX_ENTRIES }
  } catch (e) {
    return { error: e.message }
  }
})

// ========== MCP (Model Context Protocol) support ==========
// LOCAL 模式下桌面端作为 MCP 客户端代理：服务端下发 mcp_sync_required，
// 主进程用官方 Node SDK 建立连接并上报工具清单；工具执行走 tool-execute 委托。

const { Client: McpClient } = require('@modelcontextprotocol/sdk/client')
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js')
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js')
const { getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js')

const MCP_TOOL_PREFIX = 'mcp__'
const MCP_CALL_TIMEOUT_MS = 120000

/**
 * sessionId -> serverName -> { client, transport, tools }
 * @type {Map<number, Map<string, {client: import('@modelcontextprotocol/sdk/client').Client, transport: any, tools: Array}>>}
 */
const mcpClients = new Map()

function mcpServerKey(serverName) {
  return String(serverName || '')
}

/** 解析 mcp__{serverName}__{toolName}，非法名返回 null */
function parseMcpToolName(toolName) {
  if (!toolName || !toolName.startsWith(MCP_TOOL_PREFIX)) return null
  const rest = toolName.slice(MCP_TOOL_PREFIX.length)
  const sep = rest.indexOf('__')
  if (sep <= 0) return null
  const serverName = rest.slice(0, sep)
  const innerName = rest.slice(sep + 2)
  if (!serverName || !innerName) return null
  return { serverName, toolName: innerName }
}

async function connectMcpServer(sessionId, server) {
  const { name, type, command, args, url, env } = server || {}
  if (!name) throw new Error('MCP server missing name')

  let transport
  if (type === 'STDIO') {
    if (!command) throw new Error(`MCP server "${name}": STDIO requires command`)
    // 合并默认安全环境（PATH/HOME 等），再叠加管理员配置的环境变量
    const mergedEnv = { ...getDefaultEnvironment() }
    if (env && typeof env === 'object') {
      for (const [k, v] of Object.entries(env)) {
        if (v != null) mergedEnv[k] = String(v)
      }
    }
    transport = new StdioClientTransport({
      command,
      args: Array.isArray(args) ? args.map(String) : [],
      env: mergedEnv,
      stderr: 'pipe'
    })
  } else if (type === 'HTTP') {
    if (!url) throw new Error(`MCP server "${name}": HTTP requires url`)
    transport = new StreamableHTTPClientTransport(new URL(url))
  } else {
    throw new Error(`MCP server "${name}": unsupported type "${type}"`)
  }

  const client = new McpClient({ name: 'mao-desktop', version: require('../package.json').version || '1.0.0' })
  await client.connect(transport)
  const list = await client.listTools()
  const tools = (list.tools || []).map((t) => ({
    name: t.name,
    description: t.description || '',
    schema: t.inputSchema || { type: 'object', properties: {} },
    // 透传 MCP 标准注解：服务端工作集用它标注 [只读]、审批据此对明确只读的工具免审。
    annotations: t.annotations || null
  }))
  return { client, transport, tools }
}

async function closeMcpSession(sessionId) {
  const connections = mcpClients.get(Number(sessionId))
  if (!connections) return
  mcpClients.delete(Number(sessionId))
  const names = Array.from(connections.keys())
  await Promise.allSettled(names.map(async (serverName) => {
    try {
      const conn = connections.get(serverName)
      if (conn?.client) {
        await conn.client.close()
      }
    } catch (e) {
      console.warn(`[mcp] close failed for ${serverName}:`, e.message)
    }
  }))
  console.log(`[mcp] closed ${names.length} connection(s) for session ${sessionId}`)
}

async function syncMcpServers(sessionId, servers) {
  const sid = Number(sessionId)
  // 先清理旧连接，避免重复同步时泄漏
  await closeMcpSession(sid)

  const connections = new Map()
  mcpClients.set(sid, connections)

  const reports = []
  for (const server of servers || []) {
    const name = server?.name
    if (!name) continue
    try {
      const conn = await connectMcpServer(sid, server)
      connections.set(mcpServerKey(name), conn)
      reports.push({ name, connected: true, tools: conn.tools, error: null })
      console.log(`[mcp] connected server "${name}" for session ${sid}, ${conn.tools.length} tool(s)`)
    } catch (e) {
      console.warn(`[mcp] connect failed for "${name}" (session ${sid}):`, e.message)
      reports.push({ name, connected: false, tools: [], error: e.message })
    }
  }
  return reports
}

async function callMcpTool(sessionId, serverName, toolName, args) {
  const sid = Number(sessionId)
  const connections = mcpClients.get(sid)
  const conn = connections && connections.get(mcpServerKey(serverName))
  if (!conn?.client) {
    throw new Error(`MCP server "${serverName}" is not connected (session ${sid}). Re-run the session to re-sync MCP servers.`)
  }
  const timer = setTimeout(() => {
    console.warn(`[mcp] call ${serverName}.${toolName} timed out after ${MCP_CALL_TIMEOUT_MS}ms`)
  }, MCP_CALL_TIMEOUT_MS)
  try {
    const result = await conn.client.callTool({ name: toolName, arguments: args }, undefined, {
      timeout: MCP_CALL_TIMEOUT_MS
    })
    if (result?.isError) {
      throw new Error(formatCallToolResult(result) || `MCP tool ${serverName}.${toolName} returned an error`)
    }
    // 传入完整 result，保留顶层 structuredContent（部分服务器主要或仅返回该字段）
    return formatCallToolResult(result)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 将 MCP CallToolResult 转为文本（与后端 Java McpClientManager.formatResult 语义一致）：
 * - 顶层 structuredContent 非空时优先序列化输出（结构化数据更利于模型理解）；
 * - 否则拼接 content 中的文本/图片/资源内容。
 */
function formatCallToolResult(result) {
  if (!result) return ''
  if (result.structuredContent != null) {
    try { return JSON.stringify(result.structuredContent, null, 2) } catch { /* fallthrough */ }
  }
  return formatMcpContent(result.content)
}

function formatMcpContent(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    try { return JSON.stringify(content) } catch { return String(content) }
  }
  const parts = []
  for (const item of content) {
    if (!item) continue
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text)
    } else if (item.type === 'image' && item.data) {
      parts.push(`[image data: ${item.mimeType || 'unknown'}, ${item.data.length} chars base64]`)
    } else if (item.type === 'resource' && item.resource) {
      parts.push(`[resource: ${item.resource.uri || ''}]\n${item.resource.text || ''}`)
    } else if (item.structuredContent != null) {
      try { parts.push(JSON.stringify(item.structuredContent, null, 2)) } catch { /* ignore */ }
    } else {
      try { parts.push(JSON.stringify(item)) } catch { /* ignore */ }
    }
  }
  return parts.filter(Boolean).join('\n')
}

ipcMain.handle('mcp-sync', async (event, { sessionId, servers }) => {
  if (!sessionId) return { success: false, error: 'No sessionId provided for mcp-sync.' }
  try {
    const reports = await syncMcpServers(sessionId, servers || [])
    return { success: true, reports }
  } catch (e) {
    console.error('[mcp] mcp-sync failed:', e)
    return { success: false, error: e.message, reports: [] }
  }
})

ipcMain.handle('mcp-close', async (event, { sessionId }) => {
  try {
    await closeMcpSession(Number(sessionId))
    return { success: true }
  } catch (e) {
    return { success: false, error: e.message }
  }
})

// ========== Tool execution via Streaming WS ==========

async function executeToolByName(toolName, parsedArgs, sessionId, workspace, needApproval, dangerReason, requestId, approvalHint) {
  switch (toolName) {
    case 'shell':
      return await handleShellFromWebSocket(parsedArgs, sessionId, workspace, needApproval, dangerReason, requestId, approvalHint)
    case 'read_file':
      return await handleLocalReadFile(parsedArgs, workspace, sessionId)
    case 'write_file':
      return await handleLocalWriteFile(parsedArgs, workspace, sessionId, needApproval, requestId)
    case 'edit_file':
      return await handleLocalEditFile(parsedArgs, workspace, sessionId, needApproval, requestId)
    case 'glob_search':
      return await handleLocalGlobSearch(parsedArgs, workspace, sessionId)
    case 'grep_search':
      return await handleLocalGrepSearch(parsedArgs, workspace, sessionId)
    case 'write_local_text_file':
      // dump_user_messages 委托：文件名由消息 id 决定，重复导出覆盖同一文件（幂等，dedupe=false）。
      return await handleLocalWriteTextFile(parsedArgs, sessionId, false)
    default: {
      const mcp = parseMcpToolName(toolName)
      if (mcp) {
        return await handleMcpToolFromWebSocket(mcp, parsedArgs, sessionId, needApproval, dangerReason, requestId, approvalHint)
      }
      return { error: `Unknown tool: ${toolName}` }
    }
  }
}

async function handleMcpToolFromWebSocket(mcp, parsedArgs, sessionId, needApproval, dangerReason, requestId, approvalHint) {
  // 与 shell/write_file 等一致：needApproval 时先征求用户审批再执行
  if (needApproval) {
    const description = `调用 MCP 工具 ${mcp.serverName}.${mcp.toolName}`
    const approved = await requestToolApproval(`mcp:${mcp.serverName}`, description, sessionId, dangerReason, requestId, approvalHint)
    if (!approved) {
      return { error: 'User denied MCP tool execution.' }
    }
  }
  try {
    const result = await callMcpTool(sessionId, mcp.serverName, mcp.toolName, parsedArgs)
    return { result }
  } catch (e) {
    console.error(`[mcp] tool ${mcp.serverName}.${mcp.toolName} execution failed:`, e)
    return { error: e.message || 'MCP tool execution failed' }
  }
}

ipcMain.handle('tool-execute', async (event, { toolName, args, requestId, workspace, sessionId, needApproval, dangerReason, approvalHint }) => {
  // Use the workspace from this specific tool call, falling back to currentWorkspace
  const effectiveWorkspace = workspace || currentWorkspace
  console.log('[tool-execute] received workspace:', workspace, ', effectiveWorkspace:', effectiveWorkspace, ', currentWorkspace before:', currentWorkspace, ', needApproval:', needApproval, ', dangerReason:', dangerReason)
  if (workspace) {
    console.log('[tool-execute] setting currentWorkspace:', workspace, '(was:', currentWorkspace, ')')
    currentWorkspace = workspace
  }

  let parsedArgs
  try {
    parsedArgs = typeof args === 'string' ? JSON.parse(args) : args
  } catch {
    parsedArgs = {}
  }

  try {
    const result = await executeToolByName(toolName, parsedArgs, sessionId, effectiveWorkspace, !!needApproval, dangerReason, requestId, approvalHint)
    return { requestId, result: JSON.stringify(result), error: null }
  } catch (e) {
    console.error(`Tool ${toolName} execution failed:`, e)
    return { requestId, result: null, error: e.message }
  }
})

async function handleShellFromWebSocket(args, sessionId, workspace, needApproval, dangerReason, requestId, approvalHint) {
  return localShell.handle(args, {
    conversationId: sessionId,
    workspace,
    needApproval,
    approve: (description) => ensureShellApproval(needApproval, description, sessionId, dangerReason, requestId, approvalHint),
  })
}

function extractFilePath(args) {
  return args.path || args.file || args.filePath || args.file_path || args.target_file
}

const IMAGE_EXTENSIONS = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}
const MAX_IMAGE_BYTES = 5 * 1024 * 1024

function mimeFromPath(filePath) {
  const lower = filePath.toLowerCase()
  for (const [ext, mime] of Object.entries(IMAGE_EXTENSIONS)) {
    if (lower.endsWith(ext)) return mime
  }
  return null
}

function detectMimeFromBytes(buffer) {
  if (!buffer || buffer.length < 12) return null
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'image/png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return 'image/gif'
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46
      && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return 'image/webp'
  return null
}

function formatImageSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function readLocalImage(resolvedPath, filePath) {
  const sizeBytes = fs.statSync(resolvedPath).size
  if (sizeBytes > MAX_IMAGE_BYTES) {
    return {
      content: `错误：文件过大（${formatImageSize(sizeBytes)}），图片读取上限为 ${formatImageSize(MAX_IMAGE_BYTES)}：${filePath}`,
      total_lines: 0
    }
  }
  const buffer = fs.readFileSync(resolvedPath)
  const mime = detectMimeFromBytes(buffer)
  if (!mime) {
    return {
      content: `错误：不支持的图片格式或文件内容无效：${filePath}`,
      total_lines: 0
    }
  }

  let outBuffer = buffer
  let outMime = mime
  let width = null
  let height = null
  let dimNote = ''

  const resized = promptImageResizer.resizeForPrompt(buffer, mime, nativeImage)
  if (resized) {
    outBuffer = resized.buffer
    outMime = resized.mime
    width = resized.width
    height = resized.height
    if (resized.resized) {
      try {
        const orig = nativeImage.createFromBuffer(buffer)
        if (!orig.isEmpty()) {
          const { width: ow, height: oh } = orig.getSize()
          if (ow && oh && (ow !== width || oh !== height)) {
            dimNote = `, ${ow}×${oh}→${width}×${height}`
          }
        }
      } catch { /* ignore */ }
      if (!dimNote && width && height) {
        dimNote = `, ${width}×${height}`
      }
    } else if (width && height) {
      dimNote = `, ${width}×${height}`
    }
  }

  const outSize = outBuffer.length
  const dataUri = `data:${outMime};base64,${outBuffer.toString('base64')}`
  return {
    content: `图片读取成功：${filePath} (${outMime}, ${formatImageSize(outSize)}${dimNote})`,
    total_lines: 0,
    media_type: 'image',
    mime: outMime,
    path: filePath,
    size_bytes: outSize,
    ...(width != null ? { width } : {}),
    ...(height != null ? { height } : {}),
    data_uri: dataUri
  }
}

async function handleLocalReadFile(args, workspace, maoSessionId) {
  try {
    const filePath = extractFilePath(args)
    if (!filePath) {
      return { content: '错误：缺少必填参数 path', total_lines: 0 }
    }
    const resolvedPath = resolveWorkspacePath(filePath, workspace, maoSessionId)
    if (!fs.existsSync(resolvedPath)) {
      return { content: `错误：文件不存在：${filePath}`, total_lines: 0 }
    }
    if (!fs.statSync(resolvedPath).isFile()) {
      return { content: `错误：不是普通文件：${filePath}`, total_lines: 0 }
    }
    if (mimeFromPath(filePath)) {
      return readLocalImage(resolvedPath, filePath)
    }
    const content = fs.readFileSync(resolvedPath, 'utf-8')
    const lines = content.split('\n')
    const start = args.offset || 0
    const end = args.limit ? Math.min(start + args.limit, lines.length) : lines.length
    return { content: lines.slice(start, end).join('\n'), total_lines: lines.length }
  } catch (e) {
    return { content: `错误：${e.message}`, total_lines: 0 }
  }
}

async function handleLocalWriteFile(args, workspace, sessionId, needApproval, requestId) {
  if (needApproval) {
    const approved = await requestToolApproval('write_file', args.path, sessionId, null, requestId)
    if (!approved) {
      return { success: false, error: 'User denied file write.' }
    }
  }
  try {
    const resolvedPath = resolveWorkspacePath(args.path, workspace, sessionId)
    // Snapshot before write for change tracking
    const fileExisted = fs.existsSync(resolvedPath)
    let beforeContent = ''
    if (fileExisted) {
      beforeContent = fs.readFileSync(resolvedPath, 'utf-8')
    }
    const dir = path.dirname(resolvedPath)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(resolvedPath, args.content, 'utf-8')
    // Compute file change stats
    const newLineCount = args.content.length === 0 ? 0 : args.content.split('\n').length
    const lineDelta = fileExisted
      ? computeLineDelta(beforeContent, args.content)
      : { linesAdded: newLineCount, linesDeleted: 0 }
    return {
      success: true,
      bytes_written: Buffer.byteLength(args.content, 'utf-8'),
      file_change: {
        path: args.path,
        type: fileExisted ? 'MODIFIED' : 'CREATED',
        lines_added: lineDelta.linesAdded,
        lines_deleted: lineDelta.linesDeleted
      },
      [PRIVATE_DIFF_FIELD]: buildFileChangeDiff(args.path, beforeContent, args.content)
    }
  } catch (e) {
    return { error: e.message }
  }
}

async function handleLocalEditFile(args, workspace, sessionId, needApproval, requestId) {
  if (needApproval) {
    const approved = await requestToolApproval('edit_file', args.path, sessionId, null, requestId)
    if (!approved) {
      return { success: false, error: 'User denied file edit.' }
    }
  }
  try {
    const resolvedPath = resolveWorkspacePath(args.path, workspace, sessionId)
    return writeEditedFile(
      resolvedPath,
      args.path,
      args.old_string,
      args.new_string,
      asBoolArg(args.replace_all),
    )
  } catch (e) {
    return { error: e.message }
  }
}

/**
 * LOCAL 文本落盘（dump_user_messages 的委托入口 与 渲染层粘贴附件两个来源）：
 * 把文本写到 `~/.mao/attachments/<hostKey>/<sessionId>/<fileName>`，返回本机绝对路径。
 * 落点由主进程推导（home + server host + sessionId），渲染层/服务端无法指定；
 * 写入失败不抛异常，以 { error } 形态回传（与其它 LOCAL 工具一致）。
 *
 * @param {object} args { fileName, content, maxSizeMb }
 * @param {number|string} sessionId 会话 ID
 * @param {boolean} dedupe 同名避重：true 追加 -1/-2 副本（粘贴附件），false 覆盖（dump 幂等）
 */
async function handleLocalWriteTextFile(args, sessionId, dedupe) {
  const result = await chatAttachment.writeLocalTextFileAsync({
    fileName: args?.fileName,
    content: args?.content,
    maxSizeMb: args?.maxSizeMb,
    sessionId,
    dedupe,
    homeDir: os.homedir(),
    hostKey: getServerHostKey(),
  })
  if (!result.ok) return { error: result.error }
  return { success: true, path: result.absolutePath, bytes_written: result.bytes }
}

// --- glob_search / grep_search ---

let rgAvailable = null
async function isRgAvailable() {
  if (rgAvailable !== null) return rgAvailable
  try {
    const { execFile } = require('child_process')
    await new Promise((resolve, reject) => {
      execFile('rg', ['--version'], (err) => err ? reject(err) : resolve())
    })
    rgAvailable = true
  } catch {
    rgAvailable = false
  }
  return rgAvailable
}

async function handleLocalGlobSearch(args, workspace, maoSessionId) {
  const pattern = args.pattern
  if (!pattern) return { files: [], error: 'pattern is required' }

  const headLimit = args.head_limit || 100
  const resolvedPath = args.path
    ? resolveWorkspacePath(args.path, workspace, maoSessionId)
    : (workspace || currentWorkspace || '.')

  try {
    const scope = resolveSearchScope(resolvedPath)
    let files = []
    if (await isRgAvailable()) {
      files = await globWithRg(pattern, scope, headLimit)
    } else {
      files = globWithNode(pattern, scope, headLimit)
    }

    const truncated = files.length >= headLimit
    return {
      files,
      search_root: scope.cwd,
      truncated,
      total_matched: files.length
    }
  } catch (e) {
    return { files: [], error: e.message }
  }
}

function resolveSearchScope(resolvedPath) {
  let stat
  try {
    stat = fs.statSync(resolvedPath)
  } catch {
    throw new Error(`Search path does not exist or is not accessible: ${resolvedPath}`)
  }
  if (stat.isFile()) {
    const cwd = path.dirname(resolvedPath)
    return { cwd, rgTarget: path.basename(resolvedPath), singleFile: resolvedPath }
  }
  return { cwd: resolvedPath, rgTarget: '.', singleFile: null }
}

function outputFilePath(scope, rgFilePath, workspaceRoot) {
  if (scope.singleFile) {
    const normalized = path.normalize(scope.singleFile)
    if (workspaceRoot && normalized.startsWith(path.normalize(workspaceRoot))) {
      return path.relative(workspaceRoot, normalized)
    }
    return path.basename(normalized)
  }
  return relativizeRgPath(rgFilePath, scope.cwd)
}

function relativizeRgPath(filePath, searchRoot) {
  const trimmed = filePath.startsWith('./') ? filePath.slice(2) : filePath
  if (path.isAbsolute(trimmed)) {
    const normalized = path.normalize(trimmed)
    return normalized.startsWith(searchRoot) ? path.relative(searchRoot, normalized) : normalized
  }
  return path.normalize(trimmed)
}

function globWithRg(pattern, scope, headLimit) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process')
    execFile('rg', ['--files', '--glob', pattern, scope.rgTarget], { cwd: scope.cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return reject(err)
      const lines = (stdout || '').split('\n').filter(Boolean).slice(0, headLimit)
      resolve(lines.map(l => relativizeRgPath(l, scope.cwd)))
    })
  })
}

function globWithNode(pattern, scope, headLimit) {
  const { minimatch } = require('minimatch')
  const files = []
  const searchRoot = scope.cwd

  function walk(dir) {
    if (files.length >= headLimit) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (files.length >= headLimit) return
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        walk(fullPath)
      } else if (entry.isFile()) {
        const relative = path.relative(searchRoot, fullPath)
        if (minimatch(relative, pattern) || minimatch(entry.name, pattern)) {
          files.push(relative)
        }
      }
    }
  }

  walk(searchRoot)
  return files
}

async function handleLocalGrepSearch(args, workspace, maoSessionId) {
  const pattern = args.pattern
  if (!pattern) return { matches: [], error: 'pattern is required' }

  const glob = args.glob || null
  const ignoreCase = args.ignore_case || false
  const contextLines = args.context_lines || 0
  const maxOutputChars = args.max_output_chars || 10000
  const resolvedPath = args.path
    ? resolveWorkspacePath(args.path, workspace, maoSessionId)
    : (workspace || currentWorkspace || '.')
  const workspaceRoot = workspace || currentWorkspace || '.'

  try {
    const scope = resolveSearchScope(resolvedPath)
    if (await isRgAvailable()) {
      return await grepWithRg(pattern, scope, workspaceRoot, glob, ignoreCase, contextLines, maxOutputChars)
    } else {
      return grepWithNode(pattern, scope, workspaceRoot, glob, ignoreCase, contextLines, maxOutputChars)
    }
  } catch (e) {
    return { matches: [], error: e.message }
  }
}

function grepWithRg(pattern, scope, workspaceRoot, glob, ignoreCase, contextLines, maxOutputChars) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process')
    const cmd = ['--line-number', '--no-heading']
    if (ignoreCase) cmd.push('--ignore-case')
    if (contextLines > 0) { cmd.push('--context'); cmd.push(String(contextLines)) }
    if (glob) { cmd.push('--glob'); cmd.push(glob) }
    cmd.push(pattern)
    cmd.push(scope.rgTarget)

    execFile('rg', cmd, { cwd: scope.cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err && !stdout) return resolve({ matches: [], truncated: false, total_matches: 0 })

      const lines = (stdout || '').split('\n').filter(Boolean)
      const matches = []
      let totalMatches = 0
      let charsUsed = 0
      let truncated = false

      for (const line of lines) {
        if (charsUsed + line.length + 1 > maxOutputChars) {
          truncated = true
          break
        }
        const parsed = parseRgLine(line, scope, workspaceRoot)
        if (parsed) {
          matches.push(parsed)
          totalMatches++
          charsUsed += line.length + 1
        }
      }

      resolve({ matches, truncated, total_matches: totalMatches })
    })
  })
}

function parseRgLine(line, scope, workspaceRoot) {
  if (scope.singleFile) {
    return parseRgSingleFileLine(line, scope, workspaceRoot)
  }

  const firstColon = line.indexOf(':')
  if (firstColon < 0) return null
  const secondColon = line.indexOf(':', firstColon + 1)
  if (secondColon < 0) return null

  const filePath = line.substring(0, firstColon)
  const lineNumStr = line.substring(firstColon + 1, secondColon)
  const content = line.substring(secondColon + 1)

  const lineNum = parseInt(lineNumStr, 10)
  if (isNaN(lineNum)) {
    const firstDash = line.indexOf('-')
    if (firstDash < 0) return null
    const secondDash = line.indexOf('-', firstDash + 1)
    if (secondDash < 0) return null
    const dashLineNum = parseInt(line.substring(firstDash + 1, secondDash), 10)
    if (isNaN(dashLineNum)) return null
    return { file: outputFilePath(scope, line.substring(0, firstDash), workspaceRoot), line: dashLineNum, content: line.substring(secondDash + 1) }
  }

  return { file: outputFilePath(scope, filePath, workspaceRoot), line: lineNum, content }
}

function parseRgSingleFileLine(line, scope, workspaceRoot) {
  const colon = line.indexOf(':')
  const dash = line.indexOf('-')
  let sepIdx
  if (colon > 0 && (dash < 0 || colon < dash)) {
    sepIdx = colon
  } else if (dash > 0) {
    sepIdx = dash
  } else {
    return null
  }

  const lineNum = parseInt(line.substring(0, sepIdx), 10)
  if (isNaN(lineNum)) return null

  return { file: outputFilePath(scope, '', workspaceRoot), line: lineNum, content: line.substring(sepIdx + 1) }
}

function grepWithNode(pattern, scope, workspaceRoot, glob, ignoreCase, contextLines, maxOutputChars) {
  const { minimatch } = require('minimatch')
  const flags = ignoreCase ? 'i' : ''
  let regex
  try {
    regex = new RegExp(pattern, flags)
  } catch {
    return { matches: [], error: 'Invalid regex pattern: ' + pattern }
  }

  const matches = []
  let totalMatches = 0
  let charsUsed = 0
  let truncated = false

  function scanFile(fullPath) {
    if (truncated) return
    if (glob && !minimatch(path.basename(fullPath), glob)) return

    let lines
    try { lines = fs.readFileSync(fullPath, 'utf-8').split('\n') } catch { return }

    const relative = outputFilePath(scope, fullPath, workspaceRoot)

    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        const match = { file: relative, line: i + 1, content: lines[i] }

        if (contextLines > 0) {
          const before = []
          for (let c = Math.max(0, i - contextLines); c < i; c++) before.push(lines[c])
          const after = []
          for (let c = i + 1; c <= Math.min(lines.length - 1, i + contextLines); c++) after.push(lines[c])
          if (before.length > 0) match.context_before = before
          if (after.length > 0) match.context_after = after
        }

        const entrySize = JSON.stringify(match).length
        if (charsUsed + entrySize > maxOutputChars) {
          truncated = true
          break
        }

        matches.push(match)
        totalMatches++
        charsUsed += entrySize
      }
    }
  }

  function walk(dir) {
    if (truncated) return
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }

    for (const entry of entries) {
      if (truncated) return
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue
        walk(fullPath)
      } else if (entry.isFile()) {
        scanFile(fullPath)
      }
    }
  }

  if (scope.singleFile) {
    scanFile(scope.singleFile)
  } else {
    walk(scope.cwd)
  }
  return { matches, truncated, total_matches: totalMatches }
}
