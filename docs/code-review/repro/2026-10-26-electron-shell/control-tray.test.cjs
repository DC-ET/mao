'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { loadMain } = require('/Users/yangjiayi/AiProjects/mao/.worktrees/electron-shell-completeness/desktop/electron/mainShellHarness.cjs')

// 对照组：默认托盘模式下同一状态完全正常（证明问题仅限 quit 模式）
test('对照：托盘模式关窗后文案正确且快捷键可唤起', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'tray' }, platform: 'darwin' })
  h.win().close()
  assert.equal(h.win().isDestroyed(), false, '托盘模式关窗只隐藏不销毁')
  assert.equal(h.trayMenuLabel(), '显示主窗')
  h.state.shortcutRegs[0].cb()
  assert.equal(h.win().isVisible(), true, '快捷键应唤起窗口')
})
