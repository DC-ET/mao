'use strict'

/** harness 冒烟：确认能在纯 node 下加载 main.cjs 并驱动基本壳行为 */
const test = require('node:test')
const assert = require('node:assert/strict')
const { loadMain } = require('./main-harness.cjs')

test('harness 冒烟：加载后创建窗口 + 托盘 + 注册默认快捷键', async () => {
  const h = await loadMain({})
  assert.ok(h.win(), '窗口已创建')
  assert.ok(h.tray(), '托盘已创建')
  assert.deepEqual(h.state.shortcutRegs.map((r) => r.accel), ['Alt+Shift+M'])
  assert.equal(h.trayMenuLabel(), '隐藏主窗', '窗口可见时托盘应为「隐藏主窗」')
})

test('关窗拦截：托盘模式下 close 被 preventDefault 且发一次性提示', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'tray' } })
  const w = h.win()
  w.close()
  assert.equal(w.isDestroyed(), false, '托盘模式不应销毁窗口')
  assert.equal(w.isVisible(), false, '窗口应被隐藏')
  const hints = h.state.sent.filter((s) => s.channel === 'tray-first-close-hint')
  assert.equal(hints.length, 1)
})

test('退出模式：close 不被拦截，窗口销毁', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'quit' } })
  const w = h.win()
  w.close()
  assert.equal(w.isDestroyed(), true)
})

test('托盘退出 → app.quit → before-quit 清理旗标', async () => {
  const h = await loadMain({})
  h.tray().click() // 单击托盘 = 显示/隐藏切换
  // 找托盘菜单的「退出」项点击
  const quitItem = h.tray().menuTemplate.find((i) => i.label === '退出')
  quitItem.click()
  assert.equal(h.state.quitCalls, 1)
})
