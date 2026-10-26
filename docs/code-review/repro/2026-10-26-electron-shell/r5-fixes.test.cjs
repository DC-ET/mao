'use strict'
/**
 * 第 5 轮（最终确认轮）探针集 —— 全部【通过】，用于确认 commit 02578318 两处改动的正确性。
 *
 * 覆盖点：
 *   A. createWindow() 返回值：second-instance 重建路径现在能真正 restore/show/focus；
 *      activate / 托盘 onShowHide / 快捷键回调 / whenReady 四处调用点丢弃返回值，不受影响。
 *   B. 通知 click「窗口已销毁」分支：did-finish-load 前不发跳转事件，之后补发且载荷正确；
 *      窗口存在分支仍即时发送。
 *   C. loadURL 失败回落 server-picker 时的行为：picker 加载完成同样触发 did-finish-load
 *      → 补发到 picker 页（无监听者，事件被安全丢弃，不报错不悬挂）。
 *   D. 反向验证锚点：把本文件对 02578318 全绿；把 main.cjs 换成 bcffb7da 版本时
 *      A/B 失败（见 r5-reverse/ 说明）。
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const { loadMain } = require('/Users/yangjiayi/AiProjects/mao/.worktrees/electron-shell-completeness/desktop/electron/mainShellHarness.cjs')

const CLICK = 'desktop-notification-click'
const clicks = (h) => h.state.sent.filter((s) => s.channel === CLICK)

/** 构造「窗口已销毁、应用仍存活」状态：退出模式 + darwin。 */
async function makeDestroyed() {
  const h = await loadMain({ prefs: { closeToTray: 'quit' }, platform: 'darwin' })
  await h.invoke('desktop-notify', { title: '任务完成', sessionId: 42, tag: 'mao-inbox-9' })
  h.win().close()
  assert.equal(h.win().isDestroyed(), true, '前置：窗口已销毁')
  await h.tick()
  return h
}

test('A1: second-instance 在窗口销毁后重建，并能真正 restore/show/focus', async () => {
  const h = await makeDestroyed()
  const before = h.win().id
  h.emitApp('second-instance')
  // 同步断言：handler 内已 createWindow() → restore/show/focus 三步走完
  // （不能等 tick：harness 的 ready-to-show 会再调一次 show() 把 focused 复位，
  //   那是 harness 对真实 Electron「show() 已可见窗口不抢焦点」的简化，非被测行为）
  assert.notEqual(h.win().id, before, 'second-instance 应重建窗口')
  assert.equal(h.win().isDestroyed(), false)
  assert.equal(h.win().isVisible(), true, '重建后应 show（此前 createWindow 不返回值时该步被跳过）')
  assert.equal(h.win().isFocused(), true, '重建后应 focus（此前被 if (!win) return 跳过）')
  await h.tick()
  assert.equal(h.win().isDestroyed(), false, 'tick 后窗口仍在')
  assert.equal(h.win().isVisible(), true, 'tick 后窗口保持可见')
})

test('A2: second-instance 在窗口存在时直接 restore/show/focus 既有窗口（不新建）', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'tray' }, platform: 'darwin' })
  const w = h.win()
  w.minimize()
  await h.tick()
  h.emitApp('second-instance')
  assert.equal(h.windows().length, 1, '不得新建窗口')
  assert.equal(w.isMinimized(), false, '应 restore')
  assert.equal(w.isVisible(), true)
  assert.equal(w.isFocused(), true)
})

test('A3: activate 复用/重建路径不受 createWindow 返回值影响', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'quit' }, platform: 'darwin' })
  const before = h.win().id
  h.win().close()
  await h.tick()
  assert.equal(h.win().isDestroyed(), true)
  h.emitApp('activate')
  await h.tick()
  assert.notEqual(h.win().id, before, 'activate 应重建窗口')
  assert.equal(h.win().isVisible(), true, '重建后应 show')
  assert.equal(h.state.sent.filter((s) => s.channel === 'desktop-notification-click').length, 0,
    'activate 不得顺带发跳转事件')
})

test('A4: 托盘 onShowHide 与快捷键回调在无窗口时重建且不抛异常（返回值被安全丢弃）', async () => {
  const h = await makeDestroyed()
  // 托盘「显示主窗」
  const showItem = h.tray().menuTemplate.find((i) => i.label === '显示主窗')
  showItem.click()
  await h.tick()
  assert.equal(h.win().isDestroyed(), false, '托盘点击应重建窗口')
  assert.equal(h.win().isVisible(), true)

  // 快捷键回调（窗口已销毁时）
  const before = h.win().id
  h.win().close()
  await h.tick()
  assert.equal(h.win().isDestroyed(), true)
  const reg = h.state.shortcutRegs[0]
  assert.ok(reg, '应已注册快捷键')
  reg.cb()
  await h.tick()
  assert.notEqual(h.win().id, before, '快捷键应重建窗口')
  assert.equal(h.win().isVisible(), true, '快捷键重建后应 show')
})

test('B1: 通知 click（窗口已销毁）——did-finish-load 前不得发，之后补发且载荷正确', async () => {
  const h = await makeDestroyed()
  h.state.notifications[0].emit('click')
  // click 同步派发完毕
  assert.equal(h.win().isDestroyed(), false, '窗口已重建')
  assert.equal(clicks(h).length, 0, 'did-finish-load 前不得提前发跳转事件')
  assert.equal(h.win().isVisible(), false, '此刻窗口甚至还没 ready-to-show')

  h.win().emitWebContents('did-finish-load')
  assert.equal(clicks(h).length, 1, '加载完成后应补发跳转事件')
  assert.deepEqual(clicks(h)[0].data, { itemId: null, sessionId: 42 })
})

test('B2: 通知 click（窗口存在）——仍即时发送，且只发一次', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'tray' }, platform: 'darwin' })
  await h.invoke('desktop-notify', { title: '任务完成', sessionId: 7, tag: 'mao-inbox-3' })
  const w = h.win()
  w.hide()
  await h.tick()
  h.state.notifications[0].emit('click')
  assert.equal(clicks(h).length, 1, '窗口存在分支应即时发送')
  assert.deepEqual(clicks(h)[0].data, { itemId: null, sessionId: 7 })
  assert.equal(w.isVisible(), true, '应 show')
  // did-finish-load 到来不得重复发送
  w.emitWebContents('did-finish-load')
  assert.equal(clicks(h).length, 1, '不得重复发送')
})

test('B3: 通知 click（窗口存在但最小化）——先 restore 再即时发送', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'tray' }, platform: 'darwin' })
  await h.invoke('desktop-notify', { title: '任务完成', sessionId: 7 })
  const w = h.win()
  w.minimize()
  await h.tick()
  h.state.notifications[0].emit('click')
  assert.equal(w.isMinimized(), false, '应 restore')
  assert.equal(clicks(h).length, 1)
})

test('C1: loadURL 失败回落 server-picker ——picker 加载完成后补发，不悬挂不抛错', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'quit' }, platform: 'darwin' })
  // 让主窗 loadURL 失败（harness 默认 resolve，这里替换为 reject）
  const proto = Object.getPrototypeOf(h.win())
  const orig = proto.loadURL
  proto.loadURL = () => Promise.reject(new Error('net::ERR_CONNECTION_REFUSED'))
  try {
    await h.invoke('desktop-notify', { title: '任务完成', sessionId: 42 })
    h.win().close()
    await h.tick()
    assert.equal(h.win().isDestroyed(), true)
    h.state.notifications[0].emit('click')
    assert.equal(h.win().isDestroyed(), false, '窗口已重建')
    assert.equal(clicks(h).length, 0, '回落路径同样不得提前发')
    // 回落 loadServerPicker → mainWindow.loadFile(pickerHtml) → did-finish-load
    h.win().emitWebContents('did-finish-load')
    assert.equal(clicks(h).length, 1, 'picker 加载完成后补发（picker 页无监听者，事件被安全丢弃）')
    assert.deepEqual(clicks(h)[0].data, { itemId: null, sessionId: 42 })
  } finally {
    proto.loadURL = orig
  }
})

test('C2: loadURL 与 loadFile 均失败（did-finish-load 永不到达）——不悬挂、不影响其它窗口操作', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'quit' }, platform: 'darwin' })
  const proto = Object.getPrototypeOf(h.win())
  const origURL = proto.loadURL
  const origFile = proto.loadFile
  // 让主窗 loadURL 失败、回落 loadServerPicker 的 loadFile 永不 settle
  // （用「永不定态」而非 reject：main.cjs 的 loadServerPicker 对 loadFile 没有 .catch，
  //   reject 会制造与本次审查无关的 unhandledRejection 噪声）
  proto.loadURL = () => Promise.reject(new Error('boom'))
  proto.loadFile = () => new Promise(() => {})
  try {
    await h.invoke('desktop-notify', { title: '任务完成', sessionId: 42 })
    h.win().close()
    await h.tick()
    h.state.notifications[0].emit('click')
    assert.equal(h.win().isDestroyed(), false, '窗口已重建')
    assert.equal(clicks(h).length, 0, 'did-finish-load 永不到达 → 事件不发（不悬挂）')
    // 未捕获拒绝不得影响后续：再点一次已有窗口的通知仍能即时发送
    await h.invoke('desktop-notify', { title: '第二条', sessionId: 9 })
    h.state.notifications[1].emit('click')
    assert.equal(clicks(h).length, 1, '既有窗口分支仍即时发送')
    assert.deepEqual(clicks(h)[0].data, { itemId: null, sessionId: 9 })
  } finally {
    proto.loadURL = origURL
    proto.loadFile = origFile
  }
})

test('D1: 二次点击同一条通知（窗口已销毁）——重建并再次补发，不串会话', async () => {
  const h = await makeDestroyed()
  h.state.notifications[0].emit('click')
  h.win().emitWebContents('did-finish-load')
  assert.equal(clicks(h).length, 1)
  // 再关窗、再点同一条通知
  h.win().close()
  await h.tick()
  assert.equal(h.win().isDestroyed(), true)
  h.state.notifications[0].emit('click')
  assert.equal(h.win().isDestroyed(), false, '再次重建窗口')
  assert.equal(clicks(h).length, 1, '第二次 click 前仍只有 1 条')
  h.win().emitWebContents('did-finish-load')
  assert.equal(clicks(h).length, 2, '第二次 click 也应补发')
  assert.deepEqual(clicks(h)[1].data, { itemId: null, sessionId: 42 })
})
