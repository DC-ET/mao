'use strict'
/**
 * 第 4 轮（收尾轮）残留观察探针 —— 【观察级，未列为 bug】。
 *
 * 观察：desktop-notify 的 click 处理器在 else 分支 createWindow() 之后，紧接着
 * 同步调用 sendToRenderer('desktop-notification-click')。此刻新窗口连
 * 'ready-to-show' 都还没到（探针实证），而渲染层的 ipcRenderer.on(...) 属于
 * Vue 应用启动后才注册，必然更晚 —— 故该跳转事件在真实 Electron 下会丢失：
 * 窗口能出来，但「跳到对应会话」这一步不生效。
 *
 * 为何不列为 bug：
 *   1. 触发面极窄——需「退出模式 + macOS + 窗口已销毁 + 点击一条早已展示过的通知」；
 *      通知只可能由渲染层经 desktop-notify IPC 触发，而渲染层随窗口一起销毁，
 *      故此状态下只可能点击到通知中心里的旧通知。
 *   2. 相对加固前（完全空转、什么都不发生）已是严格改善。
 *   3. 彻底修复需要「待派发深链」队列（等 did-finish-load / dom-ready 再补发），
 *      属设计增强而非正确性修复。
 * 本探针只把时序事实固定下来，供后续若要完善深链时参考。
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const { loadMain } = require('/Users/yangjiayi/AiProjects/mao/.worktrees/electron-shell-completeness/desktop/electron/mainShellHarness.cjs')

test('残留：通知 click 重建窗口时，跳转事件发出时尚无渲染层可接收', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'quit' }, platform: 'darwin' })
  await h.invoke('desktop-notify', { title: '任务完成', sessionId: 42, tag: 'mao-inbox-9' })
  h.win().close()
  assert.equal(h.win().isDestroyed(), true)

  h.state.notifications[0].emit('click')

  // click 同步派发完毕：窗口已被 createWindow 建出，跳转事件也已 send
  assert.equal(h.win().isDestroyed(), false, '窗口已重建（加固生效）')
  const clicks = h.state.sent.filter((s) => s.channel === 'desktop-notification-click')
  assert.equal(clicks.length, 1, '跳转事件确实已 send')
  // 但此刻新窗口尚未 ready-to-show → 渲染层 IPC 监听更不可能已注册 → 事件丢失
  assert.equal(h.win().isVisible(), false, 'sendToRenderer 时新窗口尚未 show')

  await h.tick()
  assert.equal(h.win().isVisible(), true, 'tick 后窗口才 show（渲染层此时才开始启动）')
})
