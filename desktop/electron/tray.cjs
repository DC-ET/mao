'use strict'

/**
 * 系统托盘（P2）：app ready 后创建。菜单：显示/隐藏主窗、新建任务、退出。
 * 图标资产：各端都用应用 logo（金色羽毛）。mac 用 22pt 彩色图（另有 @2x），
 * 不用 Template——Template 只保留透明度，会把羽毛压成单色剪影。
 * win/linux 用 32px 彩色图。
 * 资产放 electron/assets/（package.json 的 files 只打包 electron/** 与 package.json，
 * public/ 不进包，不能放运行时资产）。
 */

const { Tray, Menu, nativeImage } = require('electron')
const path = require('path')

function resolveTrayIcon(platform) {
  if (platform === 'darwin') {
    // createFromPath 会一并装入同名 @2x，菜单栏按 22pt 显示。
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-icon-mac.png'))
    if (!icon.isEmpty()) return icon
  }
  return nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-icon.png'))
}

/**
 * @param {{
 *   isWindowVisible: () => boolean,
 *   onShowHide: () => void,
 *   onNewTask: () => void,
 *   onQuit: () => void,
 * }} handlers
 */
function createTray(handlers) {
  const tray = new Tray(resolveTrayIcon(process.platform))
  tray.setToolTip('Mao')

  function refresh() {
    const visible = handlers.isWindowVisible()
    const template = [
      {
        label: visible ? '隐藏主窗' : '显示主窗',
        click: handlers.onShowHide,
      },
      { type: 'separator' },
      { label: '新建任务', click: handlers.onNewTask },
      { type: 'separator' },
      { label: '退出', click: handlers.onQuit },
    ]
    tray.setContextMenu(Menu.buildFromTemplate(template))
  }

  // 单击托盘图标：显示/隐藏切换（macOS 惯例是单击显示，这里与菜单项保持同一语义）
  tray.on('click', () => {
    handlers.onShowHide()
    refresh()
  })

  refresh()
  return { tray, refresh }
}

module.exports = { createTray }
