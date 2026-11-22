const { app, BrowserWindow, ipcMain, shell, dialog, Menu, nativeImage, Tray, globalShortcut, Notification } = require('electron')
const { join } = require('path')
const { exec, spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { autoUpdater } = require('electron-updater')
const { TerminalManager } = require('./terminalManager.cjs')
const { TerminalHost } = require('./terminalHost.cjs')
const { createLocalShellRuntime, resolveShellProtocol } = require('./localShell.cjs')
const serverConfigLib = require('./serverConfig.cjs')
const authStoreLib = require('./authStore.cjs')
const { resolveShellMaoBaseUrl } = require('./shellEnv.cjs')
const chatAttachment = require('./chatAttachment.cjs')
const desktopPrefsLib = require('./desktopPrefs.cjs')
const { createTray } = require('./tray.cjs')
const { createLocalSearch } = require('./localSearch.cjs')
const { createLocalRuntimePaths } = require('./localRuntimePaths.cjs')
const { createMcpRuntime, registerMcpIpc } = require('./mcpClient.cjs')
const { registerLocalSkillsIpc } = require('./localSkills.cjs')
const { registerGitIpc } = require('./gitIpc.cjs')
const { registerLocalFileIpc } = require('./localFileIpc.cjs')
const { createBrowserLiveRuntime } = require('./browserLive.cjs')
const { createBrowserLiveRecordFlag } = require('./browserLiveRecordFlag.cjs')
const { createPipWindowManager } = require('./pipWindow.cjs')


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
 * 多端审批（技术方案 2026-11-06）：决策可能早于本地弹卡到达（手机先点 / 本机还没走到
 * requestToolApproval）。命中即直接放行、不再弹一张只能撤掉的卡。
 * TTL / 上限只为兜住无人认领的迟到决策。
 */
const EARLY_APPROVAL_TTL_MS = 10 * 60 * 1000
const EARLY_APPROVAL_LIMIT = 100
/** @type {Map<string, { approved: boolean, at: number }>} */
const earlyApprovalDecisions = new Map()
/**
 * 待派发的通知点击深链：点击时刻渲染层监听可能尚未注册（应用刚启动、
 * 页面加载中、窗口重建），立即 send 会丢。这里总是留一份，由渲染层桥接
 * 就绪后主动拉取（consume），收到后回执（ack）清除，防止页面重载后
 * 拿陈旧点击重复跳转。did-finish-load 补发仅在「尚未被拉取」时执行。
 */
let pendingNotificationClick = null
const terminalManager = new TerminalManager()
terminalManager.setEnvProvider(buildShellEnv)

// 中继终端主机（技术方案 2026-11-18 §4.6）：绑定设备的浏览器 / 安卓 / 其它电脑经服务器
// 在本机起 PTY。与 IPC 本机终端共用探测函数但两套 map 互不转发输出。
// 未登录时 connect 直接返回，等 auth-set-tokens 钩子踢重连，不空转。
const terminalHost = new TerminalHost({
  apiBaseUrl: () => getApiBaseUrl(),
  readAuth: () => readAuthStore(),
  getDeviceId: () => desktopPrefsLib.ensureDesktopDeviceId(app.getPath('userData')),
  buildEnv: buildShellEnv,
})

// ========== 领域模块接线（技术方案 2026-11-19）==========
// D2/D3：入口只传回调、不反向 require；currentWorkspace 的写入点仍只在 tool-execute。
const localRuntimePaths = createLocalRuntimePaths({
  getServerHostKey,
  getCurrentWorkspace: () => currentWorkspace,
})
const {
  resolveLocalSkillsDir,
  resolveLocalShellOutputDir,
  formatLocalRuntimePath,
  resolveWorkspacePath,
} = localRuntimePaths

// 搜索领域模块（§5.2）：路径解析来自 localRuntimePaths（含 getCurrentWorkspace 闭包）。
const localSearch = createLocalSearch({
  resolveWorkspacePath,
  getCurrentWorkspace: () => currentWorkspace,
})

// MCP 运行时（§5.4）：连接与状态在 mcpClient.cjs，入口只调导出方法，不碰内部 Map（D8）。
const mcpRuntime = createMcpRuntime()
registerMcpIpc(ipcMain, mcpRuntime)

// ========== 浏览器直播（方案 2026-11-20 v2 D10）==========
// 帧枢纽在 browserLive.cjs（LOCAL SSE 直连 sidecar / CLOUD 渲染层回灌），画中画窗口在
// pipWindow.cjs。入口只注入回调（主窗 getter / 偏好读写 / pip 页地址），不持帧状态。
const pipManager = createPipWindowManager({
  BrowserWindow,
  screen: require('electron').screen,
  pipUrl: () => pipContentUrl(),
  // 与主窗同款 preload：Electron 下 token 只存主进程（auth.json），renderer 经
  // electronAPI.getAuthTokens() 取——pip 窗口无 preload 时 getToken 为空，路由守卫把
  // /pip 重定向到登录页，画中画内容不可用（2026-11-21 Windows 真机 smoke）
  preloadPath: join(__dirname, 'preload.cjs'),
  readBounds: () => desktopPrefsLib.readDesktopPrefs(app.getPath('userData')).pipWindow ?? null,
  writeBounds: (bounds) => desktopPrefsLib.writeDesktopPrefs(app.getPath('userData'), { pipWindow: bounds }),
  shouldHideOnClose: () => !quitting,
})
const browserLive = createBrowserLiveRuntime({
  resolveSessionRuntimeDir: localRuntimePaths.resolveLocalRuntimeDir,
  getMainWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
  pip: pipManager,
})
browserLive.registerIpc(ipcMain)

// 浏览器直播录制开关取值（V202，技术方案 §3.1）：经 readiness 下发（仅登录即可读），
// 主进程缓存后向 LOCAL shell env 注入 MAO_BROWSER_LIVE_RECORD；登录态变化即失效
const browserLiveRecordFlag = createBrowserLiveRecordFlag({
  getApiBaseUrl,
  readAuth: readAuthStore,
})

/**
 * 画中画窗口加载地址：与主窗同源（生产 = 服务器 SPA；dev = vite dev server）。
 * 两者都是 createWebHistory（HTML5 路由），必须用 path 形式 /pip——hash 形式 /#/pip
 * 的 path 是 /，路由永远不匹配，画中画窗口会渲染主界面（2026-11-21 Windows 真机
 * smoke；生产 nginx 对 / 有 SPA 回退，/pip 可直达）。
 */
function pipContentUrl() {
  if (process.env.NODE_ENV === 'development' && !app.isPackaged) {
    return 'http://localhost:5201/pip'
  }
  return `${getEffectiveServerBaseUrl()}/pip`
}

let updaterInitialized = false
let updateDownloaded = false
let updateCheckPromise = null
let updaterStatus = 'idle'
let updaterProgressPercent = null

/**
 * Get the full user PATH by executing a login shell.
 * macOS GUI apps don't load shell configs, so we need to manually resolve the PATH
 * that includes all user-configured tools (nvm, brew, cargo, etc.)
 */
let cachedUserPath = null
async function resolveUserPath() {
  if (cachedUserPath) return cachedUserPath
  // Windows：GUI 启动的进程本就携带完整 PATH，登录壳解析是 macOS 专属逻辑；
  // 若 SHELL 残留 bash.exe（如从 Git Bash 启动 dev 实例），登录壳会输出 POSIX 形态
  // PATH（/usr/bin:/bin:...），塞进 spawn env 后 Windows 解析不到 powershell.exe，
  // 报 spawn ENOENT（2026-11-21 Windows 真机 smoke）。
  if (process.platform === 'win32') return process.env.PATH

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
 * 同时注入 MAO_BASE_URL（当前连接的服务器），shell 里的 mao / mao-agent 不再依赖内置默认地址。
 */
async function buildShellEnv() {
  const userPath = await resolveUserPath()
  const { token } = readAuthStore()
  const env = {
    ...process.env,
    PATH: userPath,
    TERM: 'dumb',
    PS1: '',
    // browser-use sidecar 钉死本地 SSE 出口：这里的 MAO_TOKEN 是用户 access token，
    // wrapper 的 cloud 启发式若被误触发，runner 握手会被后端拒（要求 shell token 且
    // 仅 CLOUD 会话）（2026-11-21 Windows 真机 smoke）
    MAO_BROWSER_LIVE_MODE: 'local'
  }
  if (token) {
    env.MAO_TOKEN = token
  } else {
    delete env.MAO_TOKEN
  }
  const maoBaseUrl = resolveShellMaoBaseUrl({
    configured: isServerConfigured(),
    serverBaseUrl: getEffectiveServerBaseUrl()
  })
  if (maoBaseUrl) {
    env.MAO_BASE_URL = maoBaseUrl
  } else {
    delete env.MAO_BASE_URL
  }
  // 浏览器直播录制开关（V202）：开启时 sidecar 采集侧把每场直播落盘为回放
  if (await browserLiveRecordFlag.get()) {
    env.MAO_BROWSER_LIVE_RECORD = '1'
  } else {
    delete env.MAO_BROWSER_LIVE_RECORD
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
  const maoBaseUrl = resolveShellMaoBaseUrl({
    configured: isServerConfigured(),
    serverBaseUrl: getEffectiveServerBaseUrl()
  })
  if (maoBaseUrl) {
    session.writeStdin(protocol.envSet('MAO_BASE_URL', maoBaseUrl) + '\n')
  } else {
    session.writeStdin(protocol.envUnset('MAO_BASE_URL') + '\n')
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

    // 决策已先行到达（多端审批的早到窗口）：直接按它放行，不弹本地卡
    const early = earlyApprovalDecisions.get(requestId)
    if (early) {
      earlyApprovalDecisions.delete(requestId)
      resolve(!!early.approved)
      return
    }

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

function pruneEarlyApprovalDecisions(now = Date.now()) {
  for (const [requestId, entry] of earlyApprovalDecisions) {
    if (now - entry.at > EARLY_APPROVAL_TTL_MS) earlyApprovalDecisions.delete(requestId)
  }
  while (earlyApprovalDecisions.size > EARLY_APPROVAL_LIMIT) {
    const oldest = earlyApprovalDecisions.keys().next()
    if (oldest.done) break
    earlyApprovalDecisions.delete(oldest.value)
  }
}

/**
 * 多端审批的唯一解锁入口（技术方案 2026-11-06 §4.5-10）：
 * 本地 IPC 卡点击、远端 resolved 回声、切会话清理都走这里。
 * 有 pending 就直接 resolve；没有就写入早到缓冲（不读 locallyReleased，那个由渲染层决定）。
 */
ipcMain.handle('tool-approval-remote-response', (event, payload = {}) => {
  const requestId = payload?.requestId
  if (!requestId) return false
  const resolve = pendingApprovals.get(requestId)
  if (resolve) {
    pendingApprovals.delete(requestId)
    resolve(!!payload.approved)
    return true
  }
  earlyApprovalDecisions.set(requestId, { approved: !!payload.approved, at: Date.now() })
  pruneEarlyApprovalDecisions()
  return false
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

// 技能同步与本地技能（技术方案 2026-11-19 §5.5）：~/.agents/skills 根目录注入，单测指向临时目录。
registerLocalSkillsIpc(ipcMain, {
  sendToRenderer,
  getApiBaseUrl,
  resolveLocalSkillsDir,
  getLocalAgentsSkillsDir: () => path.join(os.homedir(), '.agents', 'skills'),
})

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
  await mcpRuntime.closeAll()
}

/**
 * 切换服务器：校验 → 可选探测 → host 变化时关掉本机终端/MCP/Shell → 写配置 → 加载目标站。
 * 登录按 host 分槽保留，这里不清 auth.json。
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

  // 历史只记「连接成功」过的地址，置顶去重供快速切换
  try {
    serverConfigLib.recordServerHistory(app.getPath('userData'), targetBase, allowHttp)
  } catch (e) {
    console.warn('[server] history record failed:', e?.message)
  }
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
    width: 560,
    useContentSize: true,
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
  // 等待审批任务栏闪烁（批次 29 提案 5）：切回窗口即停——flashActive 为真才复位，避免重复发
  mainWindow.on('focus', () => {
    if (!flashActive) return
    flashActive = false
    try { mainWindow.flashFrame(false) } catch { /* ignore */ }
  })

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
  // 渲染层粘贴附件入口：同名避重，不覆盖已有附件。
  // handleLocalWriteTextFile 回的是工具协议 { success, path, bytes_written } / { error }，
  // 渲染层与 local-copy-attachment 对齐，只认 { ok, absolutePath, error }。
  // 直接把工具形态透传出去时，写盘成功也会被当成失败（error 为空 → 「写入失败」），
  // 粘贴超长文本发送会被整单取消。
  const result = await handleLocalWriteTextFile(payload, payload?.sessionId, true)
  if (result?.success && result.path) {
    return { ok: true, absolutePath: result.path }
  }
  return { ok: false, error: result?.error || '写入失败' }
})

// 等待审批任务栏闪烁（批次 29 提案 5）：渲染层只发沿信号，主进程统一管理闪烁生命周期
// （Windows 任务栏闪烁直到 focus 复位；macOS dock 弹跳自停，flashFrame(false) 对其是 no-op）
let flashActive = false
ipcMain.handle('desktop-flash-frame', (event, on) => {
  const win = mainWindow
  if (!win || win.isDestroyed()) return { ok: false }
  flashActive = !!on
  try { win.flashFrame(flashActive) } catch { /* 平台不支持时静默 */ }
  return { ok: true }
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

// 本机设备身份（技术方案 2026-11-05 §4.2）：deviceId 首次取用时生成并落盘（ensure），
// 名字用主机名、平台用 process.platform——渲染层 WS auth 帧与建 LOCAL 会话时携带。
ipcMain.handle('device-info-get', () => {
  return {
    id: desktopPrefsLib.ensureDesktopDeviceId(app.getPath('userData')),
    name: os.hostname(),
    platform: process.platform,
  }
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
  // 中继终端主机：登录后即连（未登录时空转），登出/账号切换由 token 钩子收敛
  terminalHost.start()
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
  terminalHost.shutdown()
  localShell.closeAll()
  localShell.stopCleanup()
  // 关闭全部 MCP 连接（stdio 子进程 / HTTP 会话）
  mcpRuntime.closeAll()
  // 断开直播 SSE、销毁画中画窗口
  browserLive.shutdown()
  pipManager.shutdown()
})

// ========== Auth token persistence (file:// localStorage is not reliable) ==========
// 按服务器 host 分槽。渲染进程在 preload 里钉死本次文档的 host，
// 避免切换过程中把旧页面刷出的新票写进新站的槽。

function readAuthStore() {
  try {
    return authStoreLib.readAuthTokens(app.getPath('userData'), getServerHostKey())
  } catch (e) {
    console.error('[auth] Failed to read auth store:', e.message)
    return { token: null, refreshToken: null }
  }
}

function hostFromAuthPayload(payload) {
  const host = payload && typeof payload.serverHost === 'string' ? payload.serverHost : ''
  if (authStoreLib.isHostKey(host)) return host
  return getServerHostKey()
}

ipcMain.on('auth-current-host', (event) => {
  event.returnValue = getServerHostKey()
})

ipcMain.handle('auth-get-tokens', (_event, payload) => {
  try {
    return authStoreLib.readAuthTokens(app.getPath('userData'), hostFromAuthPayload(payload))
  } catch (e) {
    console.error('[auth] Failed to read auth store:', e.message)
    return { token: null, refreshToken: null }
  }
})

ipcMain.handle('auth-set-tokens', (_event, payload = {}) => {
  try {
    authStoreLib.writeAuthTokens(app.getPath('userData'), hostFromAuthPayload(payload), {
      token: payload.token || null,
      refreshToken: payload.refreshToken || null,
    })
  } catch (e) {
    console.error('[auth] Failed to write auth store:', e.message)
  }
  // 终端主机只标「下次重连用新 token」；userId 变化（账号切换）时杀掉旧账号的 PTY（§4.5）
  terminalHost.onTokensWritten(payload.token || null)
  // 录制开关缓存随登录态失效（V202）：下次 shell 执行按新账号重新拉 readiness
  browserLiveRecordFlag.invalidate()
})

ipcMain.handle('auth-clear-tokens', (_event, payload) => {
  try {
    authStoreLib.clearAuthTokens(app.getPath('userData'), hostFromAuthPayload(payload))
  } catch (e) {
    console.error('[auth] Failed to write auth store:', e.message)
  }
  // 登出：关闭主机 socket 并杀掉中继 PTY（§4.6）
  terminalHost.onLoggedOut()
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
    history: serverConfigLib.readServerHistory(app.getPath('userData')),
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

ipcMain.handle('server-picker-close', () => {
  if (serverPickerWindow && !serverPickerWindow.isDestroyed()) {
    serverPickerWindow.close()
  }
  return { ok: true }
})

ipcMain.handle('server-config-remove-history', (_event, payload = {}) => {
  const target = String(payload?.serverBaseUrl || '').trim()
  const userData = app.getPath('userData')
  if (!target) return { ok: false, error: '缺少地址', history: serverConfigLib.readServerHistory(userData) }
  const before = serverConfigLib.readServerHistory(userData)
  const removed = before.find((entry) => entry.serverBaseUrl === target)
  const history = serverConfigLib.removeServerHistory(userData, target)
  let authCleared = false
  if (removed) {
    const host = serverConfigLib.serverHostKey(removed.serverBaseUrl)
    const remainingHosts = history.map((entry) => serverConfigLib.serverHostKey(entry.serverBaseUrl))
    if (authStoreLib.shouldForgetAuthHost(host, getServerHostKey(), remainingHosts)) {
      try {
        authCleared = authStoreLib.clearAuthTokens(userData, host)
      } catch (e) {
        console.error('[auth] Failed to forget removed server:', e.message)
      }
    }
  }
  return { ok: true, history, authCleared }
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

// Git IPC（技术方案 2026-11-19 §5.6）：通道名与失败形状原样保留（D7），workspace 缺省回退 currentWorkspace。
registerGitIpc(ipcMain, { getWorkspace: () => currentWorkspace })

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


// 本地文件 IPC 与 WS 工具入口（技术方案 2026-11-19 §5.7）：读写盘实现共享，审批差异留在两处入口。
const localFileTools = registerLocalFileIpc(ipcMain, {
  resolveWorkspacePath,
  requestToolApproval,
  nativeImage,
})

// ========== Tool execution via Streaming WS ==========

async function executeToolByName(toolName, parsedArgs, sessionId, workspace, needApproval, dangerReason, requestId, approvalHint) {
  switch (toolName) {
    case 'shell':
      return await handleShellFromWebSocket(parsedArgs, sessionId, workspace, needApproval, dangerReason, requestId, approvalHint)
    case 'read_file':
      return await localFileTools.handleLocalReadFile(parsedArgs, workspace, sessionId)
    case 'write_file':
      return await localFileTools.handleLocalWriteFile(parsedArgs, workspace, sessionId, needApproval, requestId)
    case 'edit_file':
      return await localFileTools.handleLocalEditFile(parsedArgs, workspace, sessionId, needApproval, requestId)
    case 'glob_search':
      return await localSearch.handleGlobSearch(parsedArgs, workspace, sessionId)
    case 'grep_search':
      return await localSearch.handleGrepSearch(parsedArgs, workspace, sessionId)
    case 'write_local_text_file':
      // dump_user_messages 委托：文件名由消息 id 决定，重复导出覆盖同一文件（幂等，dedupe=false）。
      return await handleLocalWriteTextFile(parsedArgs, sessionId, false)
    default: {
      const mcp = mcpRuntime.parseToolName(toolName)
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
    const result = await mcpRuntime.callTool(sessionId, mcp.serverName, mcp.toolName, parsedArgs)
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
  // 浏览器直播发现（方案 2026-11-20 v2 D3/D10）：shell 工具执行意味着 wrapper 可能拉起
  // sidecar，轮询该会话运行时的 live.json 并直连 SSE。非 shell / 无会话不触发。
  if (toolName === 'shell' && sessionId != null) {
    try { browserLive.attachLocalSession(Number(sessionId)) } catch { /* 直播尽力而为 */ }
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
    approve: async (description) => {
      const approved = await ensureShellApproval(needApproval, description, sessionId, dangerReason, requestId, approvalHint)
      // 直播发现再挂一次：attach 的轮询窗口对准真实执行期——工具帧到达即 attach 会把
      // 窗口烧在审批等待里（2026-11-21 Windows 真机 smoke）。轮询在途时重挂会重置计数
      // 延长窗口（真机实测：批准后 wrapper 再过数秒才落盘 live.json，早退会两头落空）。
      if (approved) {
        try { browserLive.attachLocalSession(Number(sessionId)) } catch { /* 直播尽力而为 */ }
      }
      return approved
    },
  })
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
