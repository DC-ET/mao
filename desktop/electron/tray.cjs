'use strict'

/**
 * 系统托盘（P2）：app ready 后创建。菜单：显示/隐藏主窗、新建任务、退出。
 * 图标资产：mac 用 Template png（明暗自适应，setTemplateImage）；win/linux 用普通 png。
 * 资产放 electron/assets/（package.json 的 files 只打包 electron/** 与 package.json，
 * public/ 不进包，不能放运行时资产）。
 */

const { Tray, Menu, nativeImage } = require('electron')
const path = require('path')

function resolveTrayIcon(platform) {
  if (platform === 'darwin') {
    const template = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-icon-template.png'))
    if (template.isEmpty()) {
      // 资产缺失时退回普通图标，避免托盘空白
      return nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-icon.png'))
    }
    template.setTemplateImage(true)
    return template
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
