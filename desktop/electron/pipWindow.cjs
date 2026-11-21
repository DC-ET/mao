'use strict'

/**
 * 画中画窗口管理（方案 2026-11-20 v2 D4）：frameless + alwaysOnTop 小窗，渲染 /#/pip。
 * 关闭一律 hide（内容与帧流保留）；位置/尺寸记忆进 desktopPrefs（按屏幕工作区校验，
 * 超界回默认位）。窗口只在首次 show 时创建，hide 不销毁——避免频繁重建丢帧。
 */

const DEFAULT_BOUNDS = { width: 384, height: 252 }
const MIN_BOUNDS = { width: 280, height: 180 }
const BOUNDS_SAVE_DEBOUNCE_MS = 600

function createPipWindowManager({
  BrowserWindow,
  screen,
  pipUrl,
  readBounds,
  writeBounds,
  shouldHideOnClose,
}) {
  /** @type {Electron.BrowserWindow | null} */
  let pipWindow = null
  let saveTimer = null

  function resolveBounds() {
    const saved = typeof readBounds === 'function' ? readBounds() : null
    if (saved && screen) {
      // 位置记忆按屏幕工作区校验：显示器变更/坐标超界时回默认位（v1 决策记录 4）
      const onAnyDisplay = screen.getAllDisplays().some((display) => {
        const area = display.workArea
        return saved.x >= area.x - 20 && saved.y >= area.y - 20
          && saved.x + saved.width <= area.x + area.width + 20
          && saved.y + saved.height <= area.y + area.height + 20
      })
      if (onAnyDisplay) return { ...saved }
    }
    return null
  }

  function scheduleBoundsSave() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      if (!pipWindow || pipWindow.isDestroyed()) return
      const bounds = pipWindow.getBounds()
      if (typeof writeBounds === 'function') writeBounds(bounds)
    }, BOUNDS_SAVE_DEBOUNCE_MS)
    saveTimer.unref?.()
  }

  function ensureWindow() {
    if (pipWindow && !pipWindow.isDestroyed()) return pipWindow
    const bounds = resolveBounds()
    pipWindow = new BrowserWindow({
      width: bounds?.width ?? DEFAULT_BOUNDS.width,
      height: bounds?.height ?? DEFAULT_BOUNDS.height,
      ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
      minWidth: MIN_BOUNDS.width,
      minHeight: MIN_BOUNDS.height,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      fullscreenable: false,
      maximizable: false,
      minimizable: false,
      title: 'Mao · 浏览器直播',
      backgroundColor: '#101014',
      show: false,
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })
    pipWindow.setAlwaysOnTop(true, 'floating')
    pipWindow.loadURL(pipUrl())
    // 头部拖动（-webkit-app-region: drag）不产生 moved 事件的地方由这里兜底
    pipWindow.on('moved', scheduleBoundsSave)
    pipWindow.on('resized', scheduleBoundsSave)
    pipWindow.on('close', (e) => {
      // 画中画关闭 = 仅停止观看：hide 而非销毁；退出流程放行真正关闭
      if (typeof shouldHideOnClose === 'function' && shouldHideOnClose()) {
        e.preventDefault()
        pipWindow.hide()
      }
    })
    pipWindow.on('closed', () => {
      pipWindow = null
    })
    return pipWindow
  }

  function show() {
    const win = ensureWindow()
    if (!win.isVisible()) {
      win.showInactive()
    } else if (win.isMinimized()) {
      win.restore()
    }
  }

  function hide() {
    if (pipWindow && !pipWindow.isDestroyed() && pipWindow.isVisible()) {
      pipWindow.hide()
    }
  }

  function isShowing() {
    return !!(pipWindow && !pipWindow.isDestroyed() && pipWindow.isVisible())
  }

  function send(channel, data) {
    if (pipWindow && !pipWindow.isDestroyed()) {
      pipWindow.webContents.send(channel, data)
    }
  }

  function shutdown() {
    if (saveTimer) clearTimeout(saveTimer)
    if (pipWindow && !pipWindow.isDestroyed()) {
      pipWindow.destroy()
    }
    pipWindow = null
  }

  return { show, hide, isShowing, send, shutdown }
}

module.exports = { createPipWindowManager, DEFAULT_PIP_BOUNDS: DEFAULT_BOUNDS }
