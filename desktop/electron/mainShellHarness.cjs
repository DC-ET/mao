'use strict'

/**
 * main.cjs 集成测试 harness：用假 electron / electron-updater / node-pty 模块（注入 require.cache）
 * 在纯 node 下加载真实的 desktop/electron/main.cjs，驱动其桌面壳逻辑
 * （托盘 / 通知 / 快捷键 / 自启 / 单实例锁 / 关窗拦截 / LOCAL 附件 IPC）。
 *
 * FakeBrowserWindow 忠实复刻两条真实 Electron 限制：
 *   1. app ready 之前构造 BrowserWindow 会抛 "BrowserWindow can only be created after the app is ready"；
 *   2. close 事件被 preventDefault 后窗口不销毁（托盘化隐藏的语义）。
 *
 * 用法（供 mainShell.test.cjs 使用）：
 *   const { loadMain } = require('./mainShellHarness.cjs')
 *   const h = await loadMain({ prefs: { closeToTray: 'tray' }, packaged: false })
 *   h.win().close()        // 触发关窗拦截
 *   h.trayMenuLabel()      // 读托盘菜单当前「显示/隐藏主窗」文案
 *
 * options.platform 会覆写 process.platform（见 applyPlatform），用于在 linux CI 上
 * 验证 darwin / win32 专属分支（角标、window-all-closed、get-platform 等）。
 */

const path = require('path')
const fs = require('fs')
const os = require('os')

const ELECTRON_DIR = __dirname
const DESKTOP_DIR = path.dirname(ELECTRON_DIR)
const MAIN_PATH = path.join(ELECTRON_DIR, 'main.cjs')
const REAL_PLATFORM = process.platform

function purgeElectronModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(ELECTRON_DIR + path.sep) && key.endsWith('.cjs')) {
      delete require.cache[key]
    }
  }
}

/**
 * main.cjs 多处平台门控（角标 / window-all-closed / get-platform / prefs-get）
 * 直接读 process.platform，没有可注入的缝；CI 跑在 linux 上，需按 options.platform
 * 覆写才能在非 macOS 开发机/CI 上验证 darwin / win32 分支。未传 platform 时还原真实值。
 * 每个 electron/*.test.cjs 由 node --test 独立进程执行，覆写不会波及其他测试文件。
 */
function applyPlatform(platform) {
  const next = platform || REAL_PLATFORM
  if (next !== process.platform) {
    Object.defineProperty(process, 'platform', { value: next, configurable: true })
  }
}

async function loadMain(options = {}) {
  purgeElectronModules()
  applyPlatform(options.platform)

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-main-harness-'))
  const state = {
    userDataDir,
    ipcHandlers: {},
    appHandlers: {},
    notifications: [],
    trayInstances: [],
    shortcutRegs: [],
    unregisterAllCalls: 0,
    quitCalls: 0,
    loginItemSettings: [],
    sent: [], // sendToRenderer 记录
    badgeCounts: [],
    appReady: false,
    windows: [],
    menuSetCount: 0,
  }

  // ---- 假 BrowserWindow ----
  let winSeq = 0
  class FakeBrowserWindow {
    constructor(opts) {
      if (!state.appReady) {
        // 与真实 Electron 一致：app ready 之前禁止创建窗口
        throw new Error('BrowserWindow can only be created after the app is ready')
      }
      this.id = ++winSeq
      this.opts = opts || {}
      this.handlers = {}
      this.onceHandlers = {}
      this.destroyed = false
      this.visible = false
      this.minimized = false
      this.focused = false
      this.webContentsOnce = {}
      this.webContents = {
        send: (channel, data) => state.sent.push({ channel, data, windowId: this.id }),
        setWindowOpenHandler: () => {},
        openDevTools: () => {},
        on: () => {},
        // 真实 Electron 加载完成后发 did-finish-load；测试里手动 emitWebContents 触发
        once: (ev, cb) => {
          ;(this.webContentsOnce[ev] = this.webContentsOnce[ev] || []).push(cb)
        },
      }
      state.windows.push(this)
      // 真实 Electron 在渲染就绪后发 ready-to-show
      process.nextTick(() => this.emit('ready-to-show'))
    }
    on(ev, cb) { (this.handlers[ev] = this.handlers[ev] || []).push(cb); return this }
    once(ev, cb) { (this.onceHandlers[ev] = this.onceHandlers[ev] || []).push(cb); return this }
    emit(ev, ...args) {
      const once = this.onceHandlers[ev] || []
      this.onceHandlers[ev] = []
      for (const cb of once) cb(...args)
      for (const cb of (this.handlers[ev] || []).slice()) cb(...args)
    }
    loadFile() { return Promise.resolve() }
    loadURL() { return Promise.resolve() }
    /** 手动触发 webContents 的 once 事件（如 did-finish-load） */
    emitWebContents(ev, ...args) {
      for (const cb of (this.webContentsOnce[ev] || []).slice()) cb(...args)
      this.webContentsOnce[ev] = []
    }
    show() { this.visible = true; this.focused = false; this.emit('show') }
    hide() { this.visible = false; this.emit('hide') }
    minimize() { this.minimized = true; this.emit('minimize') }
    restore() { this.minimized = false; this.emit('restore') }
    focus() { this.focused = true }
    close() {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
      this.emit('close', event)
      if (!event.defaultPrevented) {
        this.destroyed = true
        this.emit('closed')
      }
    }
    isVisible() { return this.visible && !this.destroyed && !this.minimized }
    isMinimized() { return this.minimized }
    isFocused() { return this.focused }
    isDestroyed() { return this.destroyed }
    setWindowOpenHandler() {}
  }
  FakeBrowserWindow.getAllWindows = () => state.windows.filter((w) => !w.destroyed)

  // ---- 假 Tray ----
  class FakeTray {
    constructor(icon) {
      this.icon = icon
      this.menuTemplate = null
      this.clickHandlers = []
      state.trayInstances.push(this)
    }
    setToolTip() {}
    setContextMenu(menu) { this.menuTemplate = menu && menu.template ? menu.template : menu }
    on(ev, cb) { if (ev === 'click') this.clickHandlers.push(cb) }
    click() { for (const cb of this.clickHandlers) cb() }
  }

  const fakeElectron = {
    app: {
      setName() {},
      setAppUserModelId() {},
      requestSingleInstanceLock: () => options.singleInstanceLock !== false,
      on: (ev, cb) => { (state.appHandlers[ev] = state.appHandlers[ev] || []).push(cb) },
      whenReady: () => (options.holdReady
        ? new Promise(() => {})
        : Promise.resolve().then(() => { state.appReady = true })),
      getPath: (k) => (k === 'userData' ? userDataDir : os.tmpdir()),
      isPackaged: options.packaged === true,
      isReady: () => state.appReady,
      quit: () => {
        state.quitCalls++
        for (const cb of (state.appHandlers['before-quit'] || []).slice()) cb()
        // 真实 Electron：before-quit 后窗口开始关闭
        for (const w of state.windows.filter((x) => !x.destroyed)) w.close()
      },
      setLoginItemSettings: (s) => state.loginItemSettings.push(s),
      dock: options.platform === 'darwin'
        ? { setBadgeCount: (n) => state.badgeCounts.push(n) }
        : undefined,
      getVersion: () => '0.0.351',
    },
    BrowserWindow: FakeBrowserWindow,
    ipcMain: {
      handle: (channel, cb) => { state.ipcHandlers[channel] = cb },
      on: () => {},
    },
    shell: { openExternal() {} },
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    Menu: {
      buildFromTemplate: (template) => ({ template }),
      setApplicationMenu: () => { state.menuSetCount++ },
    },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false, setTemplateImage() {} }) },
    Tray: FakeTray,
    Notification: class {
      constructor(opts) {
        this.opts = opts
        this.handlers = {}
        this.shown = false
        state.notifications.push(this)
      }
      on(ev, cb) { (this.handlers[ev] = this.handlers[ev] || []).push(cb) }
      show() { this.shown = true }
      emit(ev, ...args) { for (const cb of (this.handlers[ev] || []).slice()) cb(...args) }
    },
    globalShortcut: {
      register: (accel, cb) => {
        if (state.shortcutFailNext) {
          state.shortcutFailNext = false
          return false
        }
        state.shortcutRegs.push({ accel, cb })
        return true
      },
      unregister: (accel) => {
        state.shortcutRegs = state.shortcutRegs.filter((r) => r.accel !== accel)
      },
      unregisterAll: () => { state.unregisterAllCalls++; state.shortcutRegs = [] },
    },
  }

  const fakeUpdater = {
    autoUpdater: {
      on() {}, setFeedURL() {}, quitAndInstall() {},
      autoDownload: false, autoInstallOnAppQuit: false,
      checkForUpdates: async () => null,
    },
  }

  // ---- 假 node-pty ----
  // node-pty 1.1.0 的 npm 包只带 darwin / win32 prebuild，CI（ubuntu + npm ci
  // --ignore-scripts）下 require('node-pty') 直接抛错，会把 main.cjs 经
  // terminalManager.cjs 的传递依赖拖垮。壳层测试不驱动真实终端，注入内存假实现。
  const fakePtyProcess = () => ({
    onData() {}, onExit() {},
    write() {}, resize() {}, kill() {},
  })
  const fakeNodePty = { spawn: () => fakePtyProcess() }

  // 注入 require.cache，使 main.cjs 的 require('electron') 拿到假模块
  const electronPath = require.resolve('electron', { paths: [DESKTOP_DIR] })
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: fakeElectron }
  const updaterPath = require.resolve('electron-updater', { paths: [DESKTOP_DIR] })
  require.cache[updaterPath] = { id: updaterPath, filename: updaterPath, loaded: true, exports: fakeUpdater }
  const nodePtyPath = require.resolve('node-pty', { paths: [DESKTOP_DIR] })
  require.cache[nodePtyPath] = { id: nodePtyPath, filename: nodePtyPath, loaded: true, exports: fakeNodePty }

  // 预置桌面偏好（在 main.cjs 读取之前落盘）
  if (options.prefs) {
    fs.writeFileSync(path.join(userDataDir, 'desktop-prefs.json'), JSON.stringify(options.prefs))
  }

  require(MAIN_PATH)
  // 等 whenReady().then(...) 跑完（createWindow / initTray / 快捷键注册）
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))

  const win = () => state.windows[state.windows.length - 1] || null
  const tray = () => state.trayInstances[0] || null

  return {
    state,
    userDataDir,
    win,
    tray,
    windows: () => state.windows,
    invoke: (channel, ...args) => state.ipcHandlers[channel](null, ...args),
    emitApp: (ev, ...args) => { for (const cb of (state.appHandlers[ev] || []).slice()) cb(...args) },
    tick: async () => { await new Promise((r) => setImmediate(r)) },
    failNextShortcutRegistration: () => { state.shortcutFailNext = true },
    trayMenuLabel: () => {
      const t = tray()
      if (!t || !t.menuTemplate) return null
      const item = t.menuTemplate.find((i) => i.label === '隐藏主窗' || i.label === '显示主窗')
      return item ? item.label : null
    },
    readPrefs: () => JSON.parse(fs.readFileSync(path.join(userDataDir, 'desktop-prefs.json'), 'utf8')),
    hasPrefsFile: () => fs.existsSync(path.join(userDataDir, 'desktop-prefs.json')),
  }
}

module.exports = { loadMain, MAIN_PATH }
