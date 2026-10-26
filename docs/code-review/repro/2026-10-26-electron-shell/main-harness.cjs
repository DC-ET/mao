'use strict'

/**
 * main.cjs 集成探针：用假 electron / electron-updater 模块在纯 node 下加载
 * desktop/electron/main.cjs，驱动其 P2/P3 桌面壳逻辑（托盘/通知/快捷键/自启/
 * 单实例/关窗拦截），用于复现审查候选 bug。
 *
 * 用法：
 *   const { loadMain } = require('./main-harness.cjs')
 *   const h = await loadMain({ prefs: { closeToTray: 'tray' }, packaged: false })
 *   h.win.emit('close')          // 触发关窗拦截
 *   h.trayMenuLabel()            // 读取托盘菜单当前「显示/隐藏主窗」文案
 */

const path = require('path')
const fs = require('fs')
const os = require('os')

// 本文件位于 <repo>/docs/code-review/repro/2026-10-26-electron-shell/，
// 向上 4 层即仓库根，据此定位 desktop/electron/main.cjs（换机器/换检出路径可直接运行）。
const ELECTRON_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'desktop', 'electron')
const DESKTOP_DIR = path.dirname(ELECTRON_DIR)
const MAIN_PATH = path.join(ELECTRON_DIR, 'main.cjs')

function purgeElectronModules() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(ELECTRON_DIR + path.sep) && key.endsWith('.cjs')) {
      delete require.cache[key]
    }
  }
}

async function loadMain(options = {}) {
  purgeElectronModules()

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
      this.webContents = {
        send: (channel, data) => state.sent.push({ channel, data, windowId: this.id }),
        setWindowOpenHandler: () => {},
        openDevTools: () => {},
        on: () => {},
      }
      state.windows.push(this)
      // 真实 Electron 在渲染就绪后发 ready-to-show
      process.nextTick(() => this.emit('ready-to-show'))
    }
    on(ev, cb) { (this.handlers[ev] = this.handlers[ev] || []).push(cb); return this }
    once(ev, cb) { (this.onceHandlers[ev] = this.onceHandlers[ev] || []).push(cb); return this }
    emit(ev, ...args) {
      let event = args[0]
      if (ev === 'close' && !event) {
        event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
        args = [event]
      }
      const once = this.onceHandlers[ev] || []
      this.onceHandlers[ev] = []
      for (const cb of once) cb(...args)
      for (const cb of (this.handlers[ev] || []).slice()) cb(...args)
    }
    loadFile() { return Promise.resolve() }
    loadURL() { return Promise.resolve() }
    show() { this.visible = true; this.focused = false; this.emit('show') }
    hide() { this.visible = false; this.emit('hide') }
    minimize() { this.minimized = true; this.emit('minimize') }
    restore() { this.minimized = false; this.emit('restore') }
    focus() { this.focused = true }
    close() {
      this.emit('close')
      if (!this._lastClosePrevented) {
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
  // close 事件的 preventDefault 需要回传给 close()
  const origEmit = FakeBrowserWindow.prototype.emit
  FakeBrowserWindow.prototype.emit = function (ev, ...args) {
    if (ev === 'close') {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true } }
      origEmit.call(this, ev, event)
      this._lastClosePrevented = event.defaultPrevented
      return
    }
    origEmit.call(this, ev, ...args)
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

  // 注入 require.cache，使 main.cjs 的 require('electron') 拿到假模块
  const electronPath = require.resolve('electron', { paths: [DESKTOP_DIR] })
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: fakeElectron }
  const updaterPath = require.resolve('electron-updater', { paths: [DESKTOP_DIR] })
  require.cache[updaterPath] = { id: updaterPath, filename: updaterPath, loaded: true, exports: fakeUpdater }

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
  }
}

module.exports = { loadMain, MAIN_PATH }
