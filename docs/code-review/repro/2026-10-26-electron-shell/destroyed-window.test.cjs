'use strict'
/**
 * 第 2 轮复审探针：退出模式（closeToTray='quit'）+ macOS 下「窗口已销毁」状态。
 * macOS 的 window-all-closed 不退出应用（main.cjs L1458-1463 仅非 darwin 才 quit），
 * 所以关窗后应用仍驻留 dock + 托盘，但 mainWindow 已置 null。
 * 桌面壳的三条入口（托盘文案 / 全局快捷键 / 通知点击）都没处理这个状态。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { loadMain } = require('/Users/yangjiayi/AiProjects/mao/.worktrees/electron-shell-completeness/desktop/electron/mainShellHarness.cjs')

/** 构造「quit 模式 + macOS + 窗口已销毁」的实例 */
async function loadDestroyed() {
  const h = await loadMain({ prefs: { closeToTray: 'quit' }, platform: 'darwin' })
  h.win().close() // 退出模式：close 不被拦截 → 窗口销毁，mainWindow=null
  assert.equal(h.win().isDestroyed(), true)
  assert.equal(h.windows().filter((w) => !w.isDestroyed()).length, 0, '应无可用窗口')
  return h
}

test('候选4：窗口销毁后托盘菜单文案停留在「隐藏主窗」（与点击动作相反）', async () => {
  const h = await loadDestroyed()
  // isWindowVisible() 此时为 false，正确文案应为「显示主窗」；
  // 实际停留在窗口可见时的「隐藏主窗」，用户按文案点击反而会把窗口创建出来
  assert.equal(h.trayMenuLabel(), '显示主窗', '窗口销毁后文案应翻为「显示主窗」')
})

test('候选5：窗口销毁后按全局快捷键完全无效果（无法唤起窗口）', async () => {
  const h = await loadDestroyed()
  assert.equal(h.state.shortcutRegs.length, 1, '快捷键仍处于注册状态')
  h.state.shortcutRegs[0].cb()
  assert.equal(
    h.windows().filter((w) => !w.isDestroyed()).length, 1,
    '按快捷键后应重建出可用窗口（设计语义「否则唤起」）'
  )
})
