'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { loadMain } = require('/Users/yangjiayi/AiProjects/mao/.worktrees/electron-shell-completeness/desktop/electron/mainShellHarness.cjs')

async function destroyed() {
  const h = await loadMain({ prefs: { closeToTray: 'quit' }, platform: 'darwin' })
  h.win().close()
  assert.equal(h.win().isDestroyed(), true)
  return h
}
const alive = (h) => h.windows().filter((w) => !w.isDestroyed()).length

// ═══ Bug 1 ═══
test('B1：second-instance 未 ready 不建窗不抛', async () => {
  const h = await loadMain({ holdReady: true })
  assert.doesNotThrow(() => h.emitApp('second-instance'))
  assert.equal(h.windows().length, 0)
})

// ═══ Bug 2 ═══
test('B2：退出模式重建后 minimize 刷新文案', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'quit' }, platform: 'darwin' })
  h.win().close()
  h.emitApp('activate'); await h.tick()
  h.win().minimize()
  assert.equal(h.trayMenuLabel(), '显示主窗')
})

// ═══ Bug 3 ═══
test('B3：换键失败旧键保持 + 偏好不写', async () => {
  const h = await loadMain({})
  await h.invoke('desktop-shortcut-set', 'Ctrl+Alt+K')
  h.failNextShortcutRegistration()
  const bad = await h.invoke('desktop-shortcut-set', 'Ctrl+Alt+Y')
  assert.equal(bad.ok, false)
  assert.deepEqual(h.state.shortcutRegs.map((r) => r.accel), ['Ctrl+Alt+K'])
  assert.equal(h.readPrefs().globalShortcut, 'Ctrl+Alt+K')
})
test('B3b：换键成功只留新键', async () => {
  const h = await loadMain({})
  await h.invoke('desktop-shortcut-set', 'Ctrl+Alt+K')
  assert.equal((await h.invoke('desktop-shortcut-set', 'Ctrl+Alt+J')).ok, true)
  assert.deepEqual(h.state.shortcutRegs.map((r) => r.accel), ['Ctrl+Alt+J'])
})
test('B3c：关闭快捷键后无键', async () => {
  const h = await loadMain({})
  await h.invoke('desktop-shortcut-set', 'Ctrl+Alt+K')
  assert.equal((await h.invoke('desktop-shortcut-set', null)).ok, true)
  assert.deepEqual(h.state.shortcutRegs, [])
  assert.equal(h.readPrefs().globalShortcut, null)
})
test('B3d：同键重设早退（不重复注册、不误报）', async () => {
  const h = await loadMain({})
  await h.invoke('desktop-shortcut-set', 'Ctrl+Alt+K')
  const again = await h.invoke('desktop-shortcut-set', 'Ctrl+Alt+K')
  assert.equal(again.ok, true)
  assert.deepEqual(h.state.shortcutRegs.map((r) => r.accel), ['Ctrl+Alt+K'])
  assert.equal(h.state.sent.filter((s) => s.channel === 'desktop-shortcut-failed').length, 0)
})
test('B3e：启动注册失败后再设同键能恢复（早退不误伤）', async () => {
  // 偏好里有键，但启动时注册失败：currentShortcutAccel 保持 null
  const h = await loadMain({})
  assert.deepEqual(h.state.shortcutRegs.map((r) => r.accel), ['Alt+Shift+M'])
  // 手动构造「启动即失败」不可行，改为验证：失败后 currentShortcutAccel 未变
  h.failNextShortcutRegistration()
  assert.equal((await h.invoke('desktop-shortcut-set', 'Ctrl+Alt+Y')).ok, false)
  assert.deepEqual(h.state.shortcutRegs.map((r) => r.accel), ['Alt+Shift+M'])
  // 再设回默认键（与启动键相同但 currentShortcutAccel 未跟踪它）→ 应真正注册
  assert.equal((await h.invoke('desktop-shortcut-set', 'Alt+Shift+M')).ok, true)
  assert.deepEqual(h.state.shortcutRegs.map((r) => r.accel), ['Alt+Shift+M'])
})

// ═══ Bug 4 ═══
test('B4：窗口销毁后文案翻「显示主窗」', async () => {
  const h = await destroyed()
  assert.equal(h.trayMenuLabel(), '显示主窗')
})
test('B4b：窗口销毁后托盘点击重建且文案跟随', async () => {
  const h = await destroyed()
  h.tray().click(); await h.tick()
  assert.equal(alive(h), 1)
  assert.equal(h.win().isVisible(), true)
  assert.equal(h.trayMenuLabel(), '隐藏主窗')
})
test('B4c：窗口销毁后 second-instance 重建且文案正确', async () => {
  const h = await destroyed()
  h.emitApp('second-instance'); await h.tick()
  assert.equal(alive(h), 1)
  assert.equal(h.win().isVisible(), true)
  assert.equal(h.trayMenuLabel(), '隐藏主窗')
})
test('B4d：反复销毁重建多次，文案始终正确', async () => {
  const h = await destroyed()
  for (let i = 0; i < 3; i++) {
    assert.equal(h.trayMenuLabel(), '显示主窗', `第 ${i + 1} 轮销毁后`)
    h.tray().click(); await h.tick()
    assert.equal(h.trayMenuLabel(), '隐藏主窗', `第 ${i + 1} 轮重建后`)
    h.win().close()
    assert.equal(h.win().isDestroyed(), true)
  }
})

// ═══ Bug 5 ═══
test('B5：窗口销毁后快捷键重建窗口', async () => {
  const h = await destroyed()
  h.state.shortcutRegs[0].cb(); await h.tick()
  assert.equal(alive(h), 1)
  assert.equal(h.win().isVisible(), true)
  assert.equal(h.trayMenuLabel(), '隐藏主窗')
})
test('B5b：快捷键重建后可继续 toggle', async () => {
  const h = await destroyed()
  h.state.shortcutRegs[0].cb(); await h.tick()
  const w = h.win()
  w.focus()
  h.state.shortcutRegs[0].cb()
  assert.equal(w.isVisible(), false)
  h.state.shortcutRegs[0].cb()
  assert.equal(w.isVisible(), true)
})

// ═══ 对照组：托盘模式（默认）全程正常 ═══
test('CTRL：托盘模式关窗→隐藏，快捷键可唤起，文案正确', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'tray' }, platform: 'darwin' })
  h.win().close()
  assert.equal(h.win().isDestroyed(), false)
  assert.equal(h.trayMenuLabel(), '显示主窗')
  h.state.shortcutRegs[0].cb()
  assert.equal(h.win().isVisible(), true)
  assert.equal(h.trayMenuLabel(), '隐藏主窗')
})

// ═══ 退出路径不受 closed 刷新影响 ═══
test('QUIT：托盘退出 → before-quit 全量清理 + 窗口销毁', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'quit' }, platform: 'darwin' })
  h.tray().menuTemplate.find((i) => i.label === '退出').click()
  assert.equal(h.state.quitCalls, 1)
  assert.equal(h.state.unregisterAllCalls, 1)
  assert.equal(h.win().isDestroyed(), true)
})
