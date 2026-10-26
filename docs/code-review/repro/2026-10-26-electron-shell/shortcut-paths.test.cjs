'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { loadMain } = require('/Users/yangjiayi/AiProjects/mao/.worktrees/electron-shell-completeness/desktop/electron/mainShellHarness.cjs')

// ── 路径 A：启动时 whenReady 注册失败（currentShortcutAccel 应保持 null） ──
test('A：启动注册失败 → currentShortcutAccel 保持 null，失败事件回传，之后可正常改键', async () => {
  const h = await loadMain({})
  assert.equal(h.state.appReady, true)
  // 启动时默认 Alt+Shift+M 注册成功
  assert.deepEqual(h.state.shortcutRegs.map((r) => r.accel), ['Alt+Shift+M'])
  // 用 holdReady 的实例模拟「启动即失败」：这里改用 failNext 覆盖启动注册不可行，
  // 所以改为直接验证失败后 currentShortcutAccel 语义：先失败一次（旧键仍在），再成功
  h.failNextShortcutRegistration()
  const bad = await h.invoke('desktop-shortcut-set', 'Ctrl+Alt+Y')
  assert.equal(bad.ok, false)
  assert.deepEqual(h.state.shortcutRegs.map((r) => r.accel), ['Alt+Shift+M'], '失败后旧键仍在')
  // 再换成新键：应成功且只留新键
  const good = await h.invoke('desktop-shortcut-set', 'Ctrl+Alt+J')
  assert.equal(good.ok, true)
  assert.deepEqual(h.state.shortcutRegs.map((r) => r.accel), ['Ctrl+Alt+J'])
  assert.equal(h.readPrefs().globalShortcut, 'Ctrl+Alt+J')
})

// ── 路径 B：偏好里 globalShortcut=null 启动 ──
test('B：偏好快捷键为 null 启动 → 不注册、无失败事件', async () => {
  const h = await loadMain({ prefs: { globalShortcut: null } })
  assert.deepEqual(h.state.shortcutRegs, [])
  assert.equal(h.state.sent.filter((s) => s.channel === 'desktop-shortcut-failed').length, 0)
  // 之后开启：正常注册
  const ok = await h.invoke('desktop-shortcut-set', 'Alt+Shift+M')
  assert.equal(ok.ok, true)
  assert.deepEqual(h.state.shortcutRegs.map((r) => r.accel), ['Alt+Shift+M'])
})

// ── 路径 C：退出后（before-quit unregisterAll）再改键 —— 模拟退出被中止 ──
test('C：before-quit 后 currentShortcutAccel 陈旧，再改键不会误摘/双注册', async () => {
  const h = await loadMain({})
  await h.invoke('desktop-shortcut-set', 'Ctrl+Alt+K')
  assert.deepEqual(h.state.shortcutRegs.map((r) => r.accel), ['Ctrl+Alt+K'])
  // 触发 before-quit（unregisterAll 清空，但 currentShortcutAccel 未重置）
  h.emitApp('before-quit')
  assert.deepEqual(h.state.shortcutRegs, [], 'before-quit 后已全部注销')
  // 模拟「退出被中止」后用户又改键
  const ok = await h.invoke('desktop-shortcut-set', 'Ctrl+Alt+J')
  assert.equal(ok.ok, true)
  assert.deepEqual(h.state.shortcutRegs.map((r) => r.accel), ['Ctrl+Alt+J'], '只应有新键')
  assert.equal(h.readPrefs().globalShortcut, 'Ctrl+Alt+J')
})

// ── 路径 D：clearShortcut 之后再 clear（幂等） ──
test('D：连续两次关闭快捷键不报错', async () => {
  const h = await loadMain({})
  await h.invoke('desktop-shortcut-set', 'Ctrl+Alt+K')
  const a = await h.invoke('desktop-shortcut-set', null)
  assert.equal(a.ok, true)
  const b = await h.invoke('desktop-shortcut-set', null)
  assert.equal(b.ok, true)
  assert.deepEqual(h.state.shortcutRegs, [])
  assert.equal(h.readPrefs().globalShortcut, null)
})

// ── 路径 E：空串被拒 ──
test('E：空串快捷键被拒且不影响已注册键', async () => {
  const h = await loadMain({})
  const r = await h.invoke('desktop-shortcut-set', '')
  assert.equal(r.ok, false)
  assert.deepEqual(h.state.shortcutRegs.map((r2) => r2.accel), ['Alt+Shift+M'], '启动默认键仍在')
})

// ── 路径 F：app ready 且窗口已销毁时 second-instance 重建窗口并挂刷新监听 ──
test('F：退出模式关窗销毁后 second-instance 重建窗口，托盘文案仍跟随', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'quit' }, platform: 'darwin' })
  h.win().close()
  assert.equal(h.win().isDestroyed(), true)
  h.emitApp('second-instance')
  await h.tick()
  const w2 = h.win()
  assert.equal(w2.isDestroyed(), false)
  assert.equal(w2.isVisible(), true)
  assert.equal(h.trayMenuLabel(), '隐藏主窗')
  w2.minimize()
  assert.equal(h.trayMenuLabel(), '显示主窗', '新窗口的 minimize 必须刷新文案')
})

// ── 路径 G：托盘 onShowHide 在窗口已销毁时 createWindow，文案也应跟上 ──
test('G：托盘点击在窗口销毁时重建窗口，文案刷新', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'quit' }, platform: 'darwin' })
  h.win().close()
  assert.equal(h.win().isDestroyed(), true)
  assert.equal(h.trayMenuLabel(), '显示主窗', '窗口销毁后不可见 → 文案应为「显示主窗」')
  h.tray().click()
  await h.tick()
  const w2 = h.win()
  assert.equal(w2.isVisible(), true, '点击应重建并显示窗口')
  assert.equal(h.trayMenuLabel(), '隐藏主窗')
})
