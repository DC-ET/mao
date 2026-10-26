'use strict'
/**
 * 第 3 轮复审探针（HEAD=3a9b3b2f）。
 *
 * 用例分三类，请勿混淆：
 *   [R4/R5/R4b/R5b] Bug 4/5 修复验证 —— 全部通过（修复正确）。
 *   [O1]             第 2 轮观察 1 的深挖复现。断言的是「理想行为」，当前代码下失败，
 *                     但经分析【不构成 bug 故未写入报告】：通知只可能由渲染层经
 *                     desktop-notify IPC 触发，而渲染层随窗口一起销毁，所以窗口销毁后
 *                     不可能有新通知，只有通知中心里已展示过的旧通知仍可点击；点击时
 *                     sendToRenderer 因 mainWindow 为 null 而静默丢弃事件（完全空转）。
 *                     叠加设计文档「退出模式维持现状」的显式取舍，定为观察级。
 *   [O4]             同键早退与 before-quit unregisterAll 的交互。断言的是「加固后行为」，
 *                     当前代码下失败，但【触发路径不可达故不构成 bug】：需要 before-quit
 *                     之后退出被中止，而 main.cjs 没有任何 before-quit preventDefault，
 *                     close 处理器在 quitting 为 true 时也直接放行，退出必然走完。
 *                     属潜在健壮性缺口，建议在 before-quit 里补 currentShortcutAccel = null。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const { loadMain } = require('/Users/yangjiayi/AiProjects/mao/.worktrees/electron-shell-completeness/desktop/electron/mainShellHarness.cjs')

async function loadDestroyed() {
  const h = await loadMain({ prefs: { closeToTray: 'quit' }, platform: 'darwin' })
  h.win().close()
  assert.equal(h.win().isDestroyed(), true)
  return h
}

// ── Bug 4 修复验证 ──
test('R4：窗口销毁后文案翻「显示主窗」（closed 监听 + 注册顺序正确）', async () => {
  const h = await loadDestroyed()
  assert.equal(h.trayMenuLabel(), '显示主窗')
})

// ── Bug 5 修复验证 ──
test('R5：窗口销毁后按快捷键重建窗口', async () => {
  const h = await loadDestroyed()
  h.state.shortcutRegs[0].cb()
  await h.tick()
  assert.equal(h.windows().filter((w) => !w.isDestroyed()).length, 1)
  assert.equal(h.win().isVisible(), true)
})

// ── 快捷键回调里 createWindow 与 appTray?.refresh 的时序 ──
test('R5b：快捷键重建后连续再按一次（toggle 语义不被破坏）', async () => {
  const h = await loadDestroyed()
  h.state.shortcutRegs[0].cb()
  await h.tick()
  const w = h.win()
  w.focus()
  assert.equal(w.isFocused(), true)
  h.state.shortcutRegs[0].cb()
  assert.equal(w.isVisible(), false, '可见且聚焦 → 隐藏')
  h.state.shortcutRegs[0].cb()
  assert.equal(w.isVisible(), true, '再按 → 唤起')
})

// ── 退出路径：新增的 'closed' 刷新是否干扰退出 ──
test('R4b：托盘退出路径下 closed 刷新不破坏退出', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'quit' }, platform: 'darwin' })
  h.tray().menuTemplate.find((i) => i.label === '退出').click()
  assert.equal(h.state.quitCalls, 1)
  assert.equal(h.win().isDestroyed(), true)
  assert.equal(h.state.unregisterAllCalls, 1, 'before-quit 仍注销快捷键')
})

// ── O1：观察级（不构成 bug，见文件头说明）──
test('O1：窗口销毁后点击系统通知 —— 跳转事件是否送达渲染层', async () => {
  const h = await loadDestroyed()
  await h.invoke('desktop-notify', { title: '任务完成', body: 'x', itemId: 1, sessionId: 7 })
  h.state.notifications[0].emit('click')
  const clicks = h.state.sent.filter((s) => s.channel === 'desktop-notification-click')
  assert.equal(clicks.length, 1, '点击通知应把跳转事件送达渲染层')
  assert.deepEqual(clicks[0].data, { itemId: 1, sessionId: 7 })
})

// ── O4：潜在健壮性缺口（触发路径不可达，不构成 bug，见文件头说明）──
test('O4：before-quit 后重设相同键 —— 键是否仍能恢复注册', async () => {
  const h = await loadMain({})
  await h.invoke('desktop-shortcut-set', 'Ctrl+Alt+K')
  h.emitApp('before-quit')
  assert.deepEqual(h.state.shortcutRegs, [], 'before-quit 已全部注销')
  // 模拟退出被中止后用户重设同一个键
  const r = await h.invoke('desktop-shortcut-set', 'Ctrl+Alt+K')
  assert.equal(r.ok, true)
  assert.deepEqual(
    h.state.shortcutRegs.map((x) => x.accel), ['Ctrl+Alt+K'],
    '重设相同键后应重新注册生效（早退不应跳过 register）'
  )
})
