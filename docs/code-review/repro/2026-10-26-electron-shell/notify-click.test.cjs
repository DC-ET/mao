'use strict'
/**
 * 第 4 轮探针：通知 click 的 else 分支 createWindow() 之后，
 * sendToRenderer 是否可能在渲染层 IPC 监听注册之前发出（事件丢失）。
 *
 * 判据（忠实于 Electron）：新窗口的 'ready-to-show' 是异步的（harness 用
 * process.nextTick 建模，真实 Electron 更晚——要等页面首帧）。渲染层的
 * ipcRenderer.on('desktop-notification-click') 属于 Vue 应用启动后才注册，
 * 必然晚于 ready-to-show。若 sendToRenderer 在 ready-to-show 之前同步发出，
 * 则该事件不可能被渲染层收到。
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const { loadMain } = require('/Users/yangjiayi/AiProjects/mao/.worktrees/electron-shell-completeness/desktop/electron/mainShellHarness.cjs')

test('N1：通知 click 的 else 分支——sendToRenderer 发出时新窗口尚未 ready-to-show', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'quit' }, platform: 'darwin' })
  await h.invoke('desktop-notify', { title: '任务完成', sessionId: 42, tag: 'mao-inbox-9' })
  h.win().close()
  assert.equal(h.win().isDestroyed(), true)

  h.state.notifications[0].emit('click')

  // click 是同步派发的：此刻 sendToRenderer 已执行完毕
  const clicks = h.state.sent.filter((s) => s.channel === 'desktop-notification-click')
  assert.equal(clicks.length, 1, '事件确实被 send 出去了')
  // 但此刻新窗口还没有 ready-to-show（harness 的 nextTick 尚未跑）
  const w = h.win()
  assert.equal(w.isVisible(), false, 'sendToRenderer 发生时新窗口尚未 show（ready-to-show 未到）')

  await h.tick()
  assert.equal(h.win().isVisible(), true, 'tick 后窗口才 show')
  // 结论：渲染层 IPC 监听注册必晚于 ready-to-show，故该 click 事件在真实 Electron 下丢失
})
