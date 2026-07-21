const { app, BrowserWindow, ipcMain, shell, dialog, Menu } = require('electron')
const { join } = require('path')
const { exec, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { autoUpdater } = require('electron-updater')
const { TerminalManager } = require('./terminalManager.cjs')


app.setName('Mao')

let mainWindow = null
let currentWorkspace = ''
/** @type {Map<string, (approved: boolean) => void>} */
const pendingApprovals = new Map()
/** @type {Map<string, {process: import('child_process').ChildProcess, cwd: string}>} */
const shellSessions = new Map()
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
 * Single-quote a value for safe use in bash (JWT 等敏感值禁止未转义写入).
 */
function shellSingleQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'"
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
 * 持久 bash 会话的 env 在 spawn 后不会自动更新；每次执行命令前重新 export。
 */
function refreshMaoTokenInShellSession(session) {
  if (!session?.process?.stdin) return
  const { token } = readAuthStore()
  if (token) {
    session.process.stdin.write('export MAO_TOKEN=' + shellSingleQuote(token) + '\n')
  } else {
    session.process.stdin.write('unset MAO_TOKEN\n')
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

function buildApplicationMenu() {
  if (!app.isReady()) return

  const template = []

  if (process.platform === 'darwin') {
    template.push({
      label: 'Mao',
      submenu: [
        { role: 'about', label: '关于 Mao' },
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

function setupAutoUpdater() {
  if (updaterInitialized) return
  updaterInitialized = true

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  const feedUrlOverride = getUpdateFeedUrlOverride()
  if (feedUrlOverride) {
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: feedUrlOverride
    })
  }

  autoUpdater.on('checking-for-update', () => {
    setUpdaterStatus('checking', null)
    sendToRenderer('update-checking', { feedUrl: feedUrlOverride || null })
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
  setupAutoUpdater()
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

function requestToolApproval(toolName, description, sessionId, dangerReason) {
  return new Promise((resolve) => {
    const requestId = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`

    pendingApprovals.set(requestId, (approved) => {
      pendingApprovals.delete(requestId)
      resolve(approved)
    })

    const payload = { requestId, toolName, description, sessionId }
    if (dangerReason) payload.dangerReason = dangerReason
    sendToRenderer('tool-approval-request', payload)
  })
}

ipcMain.handle('tool-approval-response', (event, { requestId, approved }) => {
  const resolve = pendingApprovals.get(requestId)
  if (resolve) {
    pendingApprovals.delete(requestId)
    resolve(!!approved)
  }
})

function getApiBaseUrl() {
  // 生产环境加载远程 URL，API 地址从页面 URL 推导
  if (process.env.NODE_ENV === 'development') {
    return 'http://localhost:9080/api'
  }
  return 'https://mao.etarch.cn/api'
}

const LOCAL_RUNTIME_ROOT = path.join(os.homedir(), '.mao', 'runtime')

function resolveLocalRuntimeDir(sessionId) {
  return path.join(LOCAL_RUNTIME_ROOT, String(sessionId))
}

function resolveLocalSkillsDir(sessionId) {
  return path.join(resolveLocalRuntimeDir(sessionId), 'skills')
}

function resolveLocalShellOutputDir(sessionId) {
  return path.join(resolveLocalRuntimeDir(sessionId), 'shellOutput')
}

function formatLocalRuntimePath(sessionId, ...segments) {
  return ['~/.mao/runtime', String(sessionId), ...segments].join('/')
}

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

ipcMain.handle('skill-sync', async (event, { sessionId, syncUrl, token }) => {
  if (!sessionId) {
    const err = 'No sessionId provided for skill sync.'
    sendToRenderer('skill-sync-complete', { sessionId, success: false, error: err })
    return { success: false, error: err }
  }
  try {
    const AdmZip = require('adm-zip')
    const skillsDir = resolveLocalSkillsDir(sessionId)

    const baseUrl = getApiBaseUrl()
    const fullUrl = `${baseUrl}${syncUrl}`
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

const { getGitStatus, getGitFileDiff } = require('./gitStatus.cjs')

function loadMainContent() {
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:5201')
    mainWindow.webContents.openDevTools()
    return
  }

  // 生产环境加载远程 SPA（Nginx 托管），Electron 仅提供原生壳与本地工具能力
  mainWindow.loadURL('https://mao.etarch.cn')
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

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

app.whenReady().then(() => {
  buildApplicationMenu()
  createWindow()
  if (app.isPackaged) {
    setTimeout(() => {
      checkForAppUpdate().catch((error) => {
        console.error('[updater] initial check failed:', error)
      })
    }, 3000)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.on('before-quit', () => {
  terminalManager.killAll()
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
    fs.writeFileSync(authPath, JSON.stringify(data), 'utf8')
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

ipcMain.handle('git-status', async (event, { workspace } = {}) => {
  try {
    return await getGitStatus(workspace || currentWorkspace)
  } catch (e) {
    return { isGit: false, error: e.message || '读取 Git 状态失败' }
  }
})

ipcMain.handle('git-file-diff', async (event, { workspace, path: filePath } = {}) => {
  try {
    return await getGitFileDiff(workspace || currentWorkspace, filePath)
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

ipcMain.handle('local-edit-file', async (event, { path: filePath, old_string, new_string }) => {
  const approved = await requestToolApproval('edit_file', filePath)
  if (!approved) {
    return { success: false, error: 'User denied file edit.' }
  }
  try {
    const resolvedPath = resolveWorkspacePath(filePath)
    const content = fs.readFileSync(resolvedPath, 'utf-8')
    const count = content.split(old_string).length - 1
    if (count === 0) {
      return { success: false, error: 'old_string not found in file' }
    }
    const updated = content.replaceAll(old_string, new_string)
    fs.writeFileSync(resolvedPath, updated, 'utf-8')
    const oldLines = old_string.split('\n').length
    const newLines = new_string.split('\n').length
    return {
      success: true,
      replacements: count,
      file_change: {
        path: filePath,
        type: 'MODIFIED',
        lines_added: newLines * count,
        lines_deleted: oldLines * count
      },
      [PRIVATE_DIFF_FIELD]: buildFileChangeDiff(filePath, content, updated)
    }
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

// ========== Tool execution via Streaming WS ==========

async function executeToolByName(toolName, parsedArgs, sessionId, workspace, needApproval, dangerReason) {
  switch (toolName) {
    case 'shell':
      return await handleShellFromWebSocket(parsedArgs, sessionId, workspace, needApproval, dangerReason)
    case 'read_file':
      return await handleLocalReadFile(parsedArgs, workspace, sessionId)
    case 'write_file':
      return await handleLocalWriteFile(parsedArgs, workspace, sessionId, needApproval)
    case 'edit_file':
      return await handleLocalEditFile(parsedArgs, workspace, sessionId, needApproval)
    case 'glob_search':
      return await handleLocalGlobSearch(parsedArgs, workspace, sessionId)
    case 'grep_search':
      return await handleLocalGrepSearch(parsedArgs, workspace, sessionId)
    default:
      return { error: `Unknown tool: ${toolName}` }
  }
}

ipcMain.handle('tool-execute', async (event, { toolName, args, requestId, workspace, sessionId, needApproval, dangerReason }) => {
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
    const result = await executeToolByName(toolName, parsedArgs, sessionId, effectiveWorkspace, !!needApproval, dangerReason)
    return { requestId, result: JSON.stringify(result), error: null }
  } catch (e) {
    console.error(`Tool ${toolName} execution failed:`, e)
    return { requestId, result: null, error: e.message }
  }
})

const crypto = require('crypto')
const MARKER_PREFIX = '__CMD_DONE_'
const MARKER_SUFFIX = '__'
const MAX_PREVIEW_LINES = 100
const MAX_PREVIEW_CHARS = 10000

function generateMarker() {
  return crypto.randomBytes(4).toString('hex')
}

function truncateAndSave(fullOutput, maoSessionId, shellSessionId) {
  const lines = fullOutput.split('\n')
  const truncated = lines.length > MAX_PREVIEW_LINES || fullOutput.length > MAX_PREVIEW_CHARS

  const startIdx = Math.max(0, lines.length - MAX_PREVIEW_LINES)
  let preview = lines.slice(startIdx).join('\n')
  if (preview.length > MAX_PREVIEW_CHARS) {
    preview = preview.substring(preview.length - MAX_PREVIEW_CHARS)
  }

  let outputFile = null
  if (maoSessionId && shellSessionId && truncated) {
    try {
      const outputDir = resolveLocalShellOutputDir(maoSessionId)
      fs.mkdirSync(outputDir, { recursive: true })
      const seq = Date.now()
      const fileName = `${shellSessionId}_${seq}.out`
      fs.writeFileSync(path.join(outputDir, fileName), fullOutput, 'utf-8')
      outputFile = formatLocalRuntimePath(maoSessionId, 'shellOutput', fileName)
    } catch (e) {
      console.error('[shell] Failed to write output file:', e.message)
    }
  }

  return { preview: preview.trim(), truncated, output_file: outputFile }
}

/**
 * 用 marker 机制读取 shell 进程输出，直到看到 marker 或超时
 */
function readUntilMarker(process, marker, timeoutMs) {
  return new Promise((resolve) => {
    let output = ''
    let resolved = false
    const fullMarker = MARKER_PREFIX + marker + MARKER_SUFFIX

    const onData = (data) => {
      output += data.toString()
      if (output.includes(fullMarker)) {
        finish(false)
      }
    }

    const timer = setTimeout(() => {
      finish(true)
    }, timeoutMs)

    function finish(timedOut) {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      process.stdout.removeListener('data', onData)

      // 移除 marker 行及之后的内容
      const markerIdx = output.indexOf(fullMarker)
      const cleanOutput = markerIdx >= 0 ? output.substring(0, markerIdx) : output

      resolve({
        output: cleanOutput.trim(),
        truncated: timedOut
      })
    }

    process.stdout.on('data', onData)
  })
}

async function handleShellFromWebSocket(args, sessionId, workspace, needApproval, dangerReason) {
  const { action, command, session_id, workdir, input } = args
  let resolvedWorkdir = workspace
  if (workdir && workdir !== '.') {
    resolvedWorkdir = path.isAbsolute(workdir) ? workdir : path.join(workspace || process.cwd(), workdir)
  }

  if (action === 'close') {
    const session = shellSessions.get(session_id)
    if (session) {
      session.process.kill()
      shellSessions.delete(session_id)
    }
    return { session_id, status: 'closed' }
  }

  if (action === 'list') {
    const sessions = Array.from(shellSessions.entries()).map(([id, s]) => ({
      session_id: id,
      current_workdir: s.cwd,
      command_count: s.commandCount || 0
    }))
    return { sessions, count: sessions.length }
  }

  if (action === 'write_stdin') {
    const session = shellSessions.get(session_id)
    if (!session) {
      return { error: `Session not found: ${session_id}` }
    }
    const marker = generateMarker()
    session.process.stdin.write(input + '\n')
    session.process.stdin.write('echo ' + MARKER_PREFIX + marker + MARKER_SUFFIX + '\n')
    const result = await readUntilMarker(session.process, marker, args.yield_time_ms || 5000)
    session.lastActiveAt = Date.now()
    const saved = truncateAndSave(result.output, sessionId, session_id)
    return {
      session_id,
      current_workdir: session.cwd,
      output: saved.preview,
      truncated: saved.truncated || result.truncated,
      ...(saved.output_file ? { output_file: saved.output_file } : {})
    }
  }

  // 复用已有会话
  if (session_id && shellSessions.has(session_id)) {
    const session = shellSessions.get(session_id)
    refreshMaoTokenInShellSession(session)
    const marker = generateMarker()
    session.process.stdin.write(command + '\n')
    session.process.stdin.write('echo ' + MARKER_PREFIX + marker + MARKER_SUFFIX + '\n')
    const result = await readUntilMarker(session.process, marker, args.yield_time_ms || 10000)
    session.lastActiveAt = Date.now()
    session.commandCount = (session.commandCount || 0) + 1
    const saved = truncateAndSave(result.output, sessionId, session_id)
    return {
      exit_code: 0,
      session_id,
      current_workdir: session.cwd,
      output: saved.preview,
      truncated: saved.truncated || result.truncated,
      ...(saved.output_file ? { output_file: saved.output_file } : {})
    }
  }

  // 新会话或一次性执行 — 根据后端下发的 needApproval 决定是否需要审批
  if (needApproval) {
    const approved = await requestToolApproval('shell', command, sessionId, dangerReason)
    if (!approved) {
      return { exit_code: -1, output: 'User denied command execution.' }
    }
  }

  // 创建持久化会话
  if (session_id) {
    const bashProcess = spawn('bash', ['--norc', '--noprofile'], {
      cwd: resolvedWorkdir || undefined,
      env: await buildShellEnv()
    })
    shellSessions.set(session_id, {
      process: bashProcess,
      cwd: resolvedWorkdir || '',
      commandCount: 0,
      createdAt: Date.now(),
      lastActiveAt: Date.now()
    })

    const marker = generateMarker()
    bashProcess.stdin.write(command + '\n')
    bashProcess.stdin.write('echo ' + MARKER_PREFIX + marker + MARKER_SUFFIX + '\n')
    const result = await readUntilMarker(bashProcess, marker, args.yield_time_ms || 10000)
    const session = shellSessions.get(session_id)
    session.lastActiveAt = Date.now()
    session.commandCount = 1
    const saved = truncateAndSave(result.output, sessionId, session_id)
    return {
      exit_code: 0,
      session_id,
      current_workdir: resolvedWorkdir || '',
      output: saved.preview,
      truncated: saved.truncated || result.truncated,
      ...(saved.output_file ? { output_file: saved.output_file } : {})
    }
  }

  // 无 session_id，一次性执行
  const execEnv = await buildShellEnv()
  return new Promise((resolve) => {
    const options = {
      timeout: (args.timeout || 60) * 1000,
      maxBuffer: 1024 * 1024 * 5,
      env: execEnv
    }
    if (resolvedWorkdir) options.cwd = resolvedWorkdir

    exec(command, options, (error, stdout, stderr) => {
      if (error && error.killed) {
        resolve({ exit_code: -1, output: `Command timed out after ${args.timeout || 60}s` })
      } else {
        const fullOutput = (stdout || '') + (stderr ? '\n' + stderr : '')
        const saved = truncateAndSave(fullOutput, sessionId, 'local')
        resolve({
          exit_code: error ? error.code || 1 : 0,
          session_id: 'local',
          current_workdir: resolvedWorkdir || '',
          output: saved.preview,
          truncated: saved.truncated,
          ...(saved.output_file ? { output_file: saved.output_file } : {})
        })
      }
    })
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
  const dataUri = `data:${mime};base64,${buffer.toString('base64')}`
  return {
    content: `图片读取成功：${filePath} (${mime}, ${formatImageSize(sizeBytes)})`,
    total_lines: 0,
    media_type: 'image',
    mime,
    path: filePath,
    size_bytes: sizeBytes,
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

async function handleLocalWriteFile(args, workspace, sessionId, needApproval) {
  if (needApproval) {
    const approved = await requestToolApproval('write_file', args.path, sessionId)
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

async function handleLocalEditFile(args, workspace, sessionId, needApproval) {
  if (needApproval) {
    const approved = await requestToolApproval('edit_file', args.path, sessionId)
    if (!approved) {
      return { success: false, error: 'User denied file edit.' }
    }
  }
  try {
    const resolvedPath = resolveWorkspacePath(args.path, workspace, sessionId)
    const content = fs.readFileSync(resolvedPath, 'utf-8')
    const count = content.split(args.old_string).length - 1
    if (count === 0) return { success: false, error: 'old_string not found in file' }
    const updated = content.replaceAll(args.old_string, args.new_string)
    fs.writeFileSync(resolvedPath, updated, 'utf-8')
    // Compute file change stats
    const oldLines = args.old_string.split('\n').length
    const newLines = args.new_string.split('\n').length
    const linesAdded = newLines * count
    const linesDeleted = oldLines * count
    return {
      success: true,
      replacements: count,
      file_change: {
        path: args.path,
        type: 'MODIFIED',
        lines_added: linesAdded,
        lines_deleted: linesDeleted
      },
      [PRIVATE_DIFF_FIELD]: buildFileChangeDiff(args.path, content, updated)
    }
  } catch (e) {
    return { error: e.message }
  }
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
  const minimatch = require('minimatch')
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
  const minimatch = require('minimatch')
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
