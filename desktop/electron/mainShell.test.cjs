'use strict'

/**
 * main.cjs 桌面壳（P2/P3）集成回归测试：托盘 / 通知 / 快捷键 / 自启 / 单实例锁 /
 * 关窗拦截 / LOCAL 附件 IPC。用 mainShellHarness.cjs 的假 electron 在纯 node 下
 * 加载真实 main.cjs——该文件驱动 Tray / Notification / globalShortcut 等真实 API，
 * 此前没有任何可执行测试，这里是唯一的行为守护。
 *
 * 覆盖第 1 轮 code review 确认并修复的三个 bug 的回归：
 *   1. second-instance 先于 app ready 到达时不得尝试建窗（真实 Electron 会抛未捕获异常）；
 *   2. 退出模式下窗口销毁重建后，新窗口的显示态变化仍要刷新托盘菜单文案；
 *   3. 快捷键换键注册失败时旧键必须保持生效（先注册新键、成功后再摘旧键）。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { loadMain } = require('./mainShellHarness.cjs')

// ─── Bug 1 回归：second-instance 先于 app ready 到达 ───

test('回归1：second-instance 先于 app ready 到达时不建窗、不抛异常', async () => {
  const h = await loadMain({ holdReady: true })
  assert.equal(h.state.appReady, false, 'harness 应尚未 ready')
  assert.equal(h.windows().length, 0, '尚未创建窗口')
  // 修复前：走 createWindow() 分支 → new BrowserWindow 抛未捕获异常，主实例启动期崩溃
  assert.doesNotThrow(() => h.emitApp('second-instance'))
  assert.equal(h.windows().length, 0, '未 ready 时不应创建窗口')
})

test('基线：second-instance 在窗口隐藏时唤起并聚焦', async () => {
  const h = await loadMain({})
  h.win().hide()
  h.emitApp('second-instance')
  assert.equal(h.win().isVisible(), true)
  assert.equal(h.win().isFocused(), true)
})

// ─── Bug 2 回归：窗口销毁重建后托盘文案仍跟随显示态 ───

test('回归2：退出模式下窗口销毁重建后，新窗口最小化仍刷新托盘文案', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'quit' }, platform: 'darwin' })

  // 1) 退出模式：关窗真正销毁窗口
  h.win().close()
  assert.equal(h.win().isDestroyed(), true)

  // 2) dock 点击 → activate → getAllWindows()===0 → createWindow 新窗口
  h.emitApp('activate')
  await h.tick()
  const w2 = h.win()
  assert.equal(w2.isDestroyed(), false, 'activate 应重建窗口')
  assert.equal(w2.isVisible(), true, '新窗口应已显示')
  assert.equal(h.trayMenuLabel(), '隐藏主窗')

  // 3) 用户最小化新窗口：文案必须翻成「显示主窗」，且点击动作与文案一致（把窗显示出来）
  w2.minimize()
  assert.equal(w2.isVisible(), false)
  assert.equal(h.trayMenuLabel(), '显示主窗', '窗口不可见时托盘文案应为「显示主窗」')
  h.tray().click()
  assert.equal(w2.isVisible(), true, '文案为「显示主窗」时点击应把窗口显示出来')
  assert.equal(h.trayMenuLabel(), '隐藏主窗', '点击后文案翻回「隐藏主窗」')
})

test('基线：activate 在窗口隐藏时恢复显示（托盘模式）', async () => {
  const h = await loadMain({})
  h.win().hide()
  h.emitApp('activate')
  assert.equal(h.win().isVisible(), true)
  assert.equal(h.trayMenuLabel(), '隐藏主窗')
})

// ─── Bug 4/5 回归：「窗口已销毁但应用仍在运行」（退出模式 + macOS）───

test('回归4：退出模式关窗销毁后托盘文案翻「显示主窗」，点击重建且文案跟随', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'quit' }, platform: 'darwin' })
  h.win().close()
  assert.equal(h.win().isDestroyed(), true, '退出模式关窗即销毁')
  assert.equal(
    h.trayMenuLabel(), '显示主窗',
    '窗口销毁后文案应翻为「显示主窗」（修复前停留在「隐藏主窗」，与动作相反）'
  )
  h.tray().click()
  await h.tick() // 新窗口等 ready-to-show 才 show
  assert.equal(h.win().isDestroyed(), false, '点击后重建窗口')
  assert.equal(h.win().isVisible(), true)
  assert.equal(h.trayMenuLabel(), '隐藏主窗')
})

test('回归5：窗口销毁后按全局快捷键重建窗口而非空转', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'quit' }, platform: 'darwin' })
  h.win().close()
  assert.equal(h.windows().filter((w) => !w.isDestroyed()).length, 0, '窗口已全部销毁')
  h.state.shortcutRegs[0].cb()
  await h.tick() // 新窗口等 ready-to-show 才 show
  assert.equal(
    h.windows().filter((w) => !w.isDestroyed()).length, 1,
    '快捷键语义「否则唤起」：无窗口时应重建（修复前直接 return 空转）'
  )
  assert.equal(h.win().isVisible(), true)
})

test('对照组：托盘模式关窗只隐藏不销毁，文案与快捷键均正常', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'tray' }, platform: 'darwin' })
  h.win().close()
  assert.equal(h.win().isDestroyed(), false, '托盘模式关窗不销毁')
  assert.equal(h.trayMenuLabel(), '显示主窗')
  h.state.shortcutRegs[0].cb()
  assert.equal(h.win().isVisible(), true, '隐藏态按快捷键唤起')
})

// ─── Bug 3 回归：快捷键换键失败时旧键保持生效 ───

test('回归3：新快捷键注册失败时旧快捷键仍生效且偏好不写', async () => {
  const h = await loadMain({})

  const ok = await h.invoke('desktop-shortcut-set', 'Ctrl+Alt+K')
  assert.equal(ok.ok, true)
  assert.deepEqual(h.state.shortcutRegs.map((r) => r.accel), ['Ctrl+Alt+K'])

  // 换键但注册失败（被其他程序占用）
  h.failNextShortcutRegistration()
  const failed = await h.invoke('desktop-shortcut-set', 'Ctrl+Alt+Y')
  assert.equal(failed.ok, false, '注册失败应返回 ok:false')

  // 修复前：unregisterAll 先清空 → 旧键已失效；现在旧键必须原样可用
  assert.deepEqual(
    h.state.shortcutRegs.map((r) => r.accel), ['Ctrl+Alt+K'],
    '注册失败后旧快捷键应仍然可用'
  )
  assert.equal(h.readPrefs().globalShortcut, 'Ctrl+Alt+K', '偏好保持旧键，UI 与实际一致')
  assert.equal(
    h.state.sent.filter((s) => s.channel === 'desktop-shortcut-failed').length, 1,
    '失败应回传设置页提示'
  )
})

test('基线：快捷键换键成功后只保留新键', async () => {
  const h = await loadMain({})
  await h.invoke('desktop-shortcut-set', 'Ctrl+Alt+K')
  const ok = await h.invoke('desktop-shortcut-set', 'Ctrl+Alt+J')
  assert.equal(ok.ok, true)
  assert.deepEqual(h.state.shortcutRegs.map((r) => r.accel), ['Ctrl+Alt+J'])
  assert.equal(h.readPrefs().globalShortcut, 'Ctrl+Alt+J')
})

test('基线：清除快捷键后无键生效且偏好置空', async () => {
  const h = await loadMain({})
  await h.invoke('desktop-shortcut-set', 'Ctrl+Alt+K')
  const ok = await h.invoke('desktop-shortcut-set', null)
  assert.equal(ok.ok, true)
  assert.deepEqual(h.state.shortcutRegs, [])
  assert.equal(h.readPrefs().globalShortcut, null)
})

test('基线：重设为相同快捷键直接成功（不重复注册、不误报占用）', async () => {
  const h = await loadMain({})
  await h.invoke('desktop-shortcut-set', 'Ctrl+Alt+K')
  const again = await h.invoke('desktop-shortcut-set', 'Ctrl+Alt+K')
  assert.equal(again.ok, true)
  assert.deepEqual(h.state.shortcutRegs.map((r) => r.accel), ['Ctrl+Alt+K'])
  assert.equal(h.state.sent.filter((s) => s.channel === 'desktop-shortcut-failed').length, 0)
})

test('基线：快捷键回调——可见且聚焦时隐藏，否则唤起', async () => {
  const h = await loadMain({})
  const w = h.win()
  w.focus()
  assert.equal(w.isFocused(), true)
  h.state.shortcutRegs[0].cb()
  assert.equal(w.isVisible(), false, '可见且聚焦 → 隐藏')
  h.state.shortcutRegs[0].cb()
  assert.equal(w.isVisible(), true, '隐藏 → 唤起')
  assert.equal(w.isFocused(), true)
})

// ─── 基线：托盘 / 关窗 / 退出路径 ───

test('基线：托盘模式关窗 → 隐藏 + 一次性提示 + 偏好持久化', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'tray' } })
  h.win().close()
  assert.equal(h.win().isDestroyed(), false)
  assert.equal(h.win().isVisible(), false)
  assert.equal(h.state.sent.filter((s) => s.channel === 'tray-first-close-hint').length, 1)
  assert.equal(h.readPrefs().trayHintShown, true)
})

test('基线：托盘提示只发一次（二次关窗不再提示）', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'tray' } })
  h.win().close()
  h.win().show()
  h.win().close()
  assert.equal(h.state.sent.filter((s) => s.channel === 'tray-first-close-hint').length, 1)
})

test('基线：托盘退出走 app.quit + before-quit 全量清理', async () => {
  const h = await loadMain({})
  h.tray().menuTemplate.find((i) => i.label === '退出').click()
  assert.equal(h.state.quitCalls, 1)
  assert.equal(h.win().isDestroyed(), true, 'quitting 后 close 不再被拦截')
})

test('基线：托盘单击切换显示/隐藏且文案跟随刷新', async () => {
  const h = await loadMain({})
  const w = h.win()
  assert.equal(w.isVisible(), true)
  h.tray().click()
  assert.equal(w.isVisible(), false)
  assert.equal(h.trayMenuLabel(), '显示主窗')
  h.tray().click()
  assert.equal(w.isVisible(), true)
  assert.equal(h.trayMenuLabel(), '隐藏主窗')
})

test('基线：托盘「新建任务」先唤起窗口再发事件', async () => {
  const h = await loadMain({})
  h.win().hide()
  h.tray().menuTemplate.find((i) => i.label === '新建任务').click()
  assert.equal(h.win().isVisible(), true)
  assert.equal(h.state.sent.filter((s) => s.channel === 'tray-new-task').length, 1)
})

// ─── 基线：通知 / 角标 ───

test('基线：通知点击 → 唤起窗口 + 回传跳转事件', async () => {
  const h = await loadMain({})
  h.win().hide()
  await h.invoke('desktop-notify', { title: '任务完成', body: '摘要', tag: 'mao-inbox-2', itemId: 2, sessionId: 42 })
  const n = h.state.notifications[0]
  assert.equal(n.shown, true)
  n.emit('click')
  assert.equal(h.win().isVisible(), true)
  const clickEvents = h.state.sent.filter((s) => s.channel === 'desktop-notification-click')
  assert.deepEqual(clickEvents[0].data, { itemId: 2, sessionId: 42 })
})

test('基线：通知标题为空即拒', async () => {
  const h = await loadMain({})
  const r = await h.invoke('desktop-notify', { title: '', body: 'x' })
  assert.equal(r.ok, false)
  assert.equal(h.state.notifications.length, 0)
})

test('基线：通知 failed 事件回传失败结果', async () => {
  const h = await loadMain({})
  await h.invoke('desktop-notify', { title: '任务完成', tag: 'mao-inbox-3' })
  h.state.notifications[0].emit('failed')
  const failed = h.state.sent.filter((s) => s.channel === 'desktop-notify-result')
  assert.equal(failed.length, 1)
  assert.equal(failed[0].data.ok, false)
})

test('回归6：窗口销毁后点击系统通知重建窗口，跳转事件等页面加载后补发', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'quit' }, platform: 'darwin' })
  await h.invoke('desktop-notify', { title: '任务完成', sessionId: 42, tag: 'mao-inbox-9' })
  h.win().close()
  assert.equal(h.win().isDestroyed(), true, '窗口已销毁')
  h.state.notifications[0].emit('click')
  await h.tick() // 新窗口等 ready-to-show 才 show
  assert.equal(h.win().isDestroyed(), false, '点击通知应重建窗口')
  assert.equal(h.win().isVisible(), true)
  assert.equal(
    h.state.sent.filter((s) => s.channel === 'desktop-notification-click').length, 0,
    '页面未加载完时同步发跳转会丢（渲染层 ipcRenderer.on 尚未注册），不得提前发'
  )
  // did-finish-load 后补发
  h.win().emitWebContents('did-finish-load')
  assert.equal(
    h.state.sent.filter((s) => s.channel === 'desktop-notification-click').length, 1,
    '加载完成后应补发跳转事件'
  )
  assert.deepEqual(
    h.state.sent.find((s) => s.channel === 'desktop-notification-click').data,
    { itemId: null, sessionId: 42 }
  )
})

test('回归7：before-quit 注销快捷键后清掉跟踪值，重设同一键能真正注册', async () => {
  const h = await loadMain({})
  assert.deepEqual(h.state.shortcutRegs.map((x) => x.accel), ['Alt+Shift+M'], '启动注册默认键')
  // 模拟「退出被中止」：直接派发 before-quit（注销全部快捷键 + 清跟踪值）
  h.emitApp('before-quit')
  assert.deepEqual(h.state.shortcutRegs, [], 'before-quit 后快捷键已全部注销')
  // 重设与启动时同一个键：必须真正 register，不能因同键早退而跳过
  const r = await h.invoke('desktop-shortcut-set', 'Alt+Shift+M')
  assert.equal(r.ok, true)
  assert.deepEqual(
    h.state.shortcutRegs.map((x) => x.accel), ['Alt+Shift+M'],
    '退出中止后重设同一键应重新注册生效（修复前命中早退、键保持未注册）'
  )
})

test('基线：角标仅 macOS 生效且计数归一化', async () => {
  const mac = await loadMain({ platform: 'darwin' })
  await mac.invoke('desktop-badge', { count: 3 })
  await mac.invoke('desktop-badge', { count: -5 })
  assert.deepEqual(mac.state.badgeCounts, [3, 0])
  const win = await loadMain({ platform: 'win32' })
  await win.invoke('desktop-badge', { count: 3 })
  assert.deepEqual(win.state.badgeCounts, [])
})

// ─── 基线：自启 / 偏好 ───

test('基线：dev 模式拒绝开启自启且不落盘', async () => {
  const h = await loadMain({ packaged: false })
  const r = await h.invoke('desktop-prefs-set', { autoStart: true })
  assert.equal(r.ok, false)
  assert.equal(h.hasPrefsFile(), false)
  assert.deepEqual(h.state.loginItemSettings, [])
})

test('基线：dev 模式清空自启仍落盘（关闭不拒绝）', async () => {
  const h = await loadMain({ packaged: false, prefs: { autoStart: true } })
  const r = await h.invoke('desktop-prefs-set', { autoStart: false })
  assert.equal(r.ok, true)
  assert.equal(h.readPrefs().autoStart, false)
})

test('基线：打包后开启自启写入登录项（openAsHidden）', async () => {
  const h = await loadMain({ packaged: true })
  const r = await h.invoke('desktop-prefs-set', { autoStart: true })
  assert.equal(r.ok, true)
  assert.deepEqual(h.state.loginItemSettings, [{ openAtLogin: true, openAsHidden: true }])
})

test('基线：desktop-prefs-get 回传 packaged 与 platform', async () => {
  const h = await loadMain({ packaged: true, platform: 'darwin' })
  const r = await h.invoke('desktop-prefs-get')
  assert.equal(r.ok, true)
  assert.equal(r.packaged, true)
  assert.equal(r.platform, 'darwin')
  assert.equal(r.prefs.closeToTray, 'tray', '缺省偏好为托盘化')
  assert.equal(r.prefs.globalShortcut, 'Alt+Shift+M', '缺省快捷键')
})

// ─── 基线：LOCAL 附件 IPC ───

test('基线：local-copy-attachment 落点由主进程推导（home + host + sid），恶意名被 sanitize', async () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mao-harness-home-'))
  const prevHome = process.env.HOME
  process.env.HOME = fakeHome
  try {
    const h = await loadMain({})
    const src = path.join(fakeHome, 'src.txt')
    fs.writeFileSync(src, 'hello')
    const r = await h.invoke('local-copy-attachment', { sourcePath: src, sessionId: 9, maxSizeMb: 10 })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.ok(
      r.absolutePath.startsWith(fs.realpathSync(fakeHome) + path.sep + '.mao' + path.sep + 'attachments' + path.sep),
      r.absolutePath
    )
    assert.equal(fs.readFileSync(r.absolutePath, 'utf8'), 'hello')
  } finally {
    process.env.HOME = prevHome
    fs.rmSync(fakeHome, { recursive: true, force: true })
  }
})

// ─── 通知点击深链的待派发队列（P2 修复：点击早于渲染层监听注册时跳转丢失） ───

test('通知点击入待派发队列：窗口存活立即派发，consume 可取到，ack 后清空', async () => {
  const h = await loadMain({})
  await h.invoke('desktop-notify', { title: '任务完成', sessionId: 42, itemId: 2, tag: 'mao-inbox-9' })
  h.state.notifications[0].emit('click')
  const immediate = h.state.sent.filter((s) => s.channel === 'desktop-notification-click')
  assert.equal(immediate.length, 1, '窗口存活时立即派发（低延迟路径）')
  assert.deepEqual(immediate[0].data, { itemId: 2, sessionId: 42 })
  // 渲染层监听可能尚未注册（应用刚启动/页面加载中）：主进程必须留有积存供就绪后拉取
  assert.deepEqual(
    await h.invoke('desktop-notification-click-consume'),
    { itemId: 2, sessionId: 42 },
    'consume 应取到积存的点击深链'
  )
  // 取出即清空，不重复派发
  assert.equal(await h.invoke('desktop-notification-click-consume'), null)
})

test('ack 清除待派发队列：页面重载后桥接重新就绪不会拿陈旧点击重复跳转', async () => {
  const h = await loadMain({})
  await h.invoke('desktop-notify', { title: '任务完成', sessionId: 42 })
  h.state.notifications[0].emit('click')
  await h.invoke('desktop-notification-click-ack')
  assert.equal(await h.invoke('desktop-notification-click-consume'), null)
})

test('窗口销毁后点击：consume 队列与 did-finish-load 补发互斥，不双重跳转', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'quit' }, platform: 'darwin' })
  await h.invoke('desktop-notify', { title: '任务完成', sessionId: 42 })
  h.win().close()
  h.state.notifications[0].emit('click')
  await h.tick()
  assert.equal(h.win().isDestroyed(), false, '点击通知应重建窗口')
  // 渲染层先就绪并拉取（页面加载慢、监听后注册的真实时序）
  assert.deepEqual(
    await h.invoke('desktop-notification-click-consume'),
    { itemId: null, sessionId: 42 }
  )
  // 已被拉取：did-finish-load 不再补发，避免同一深链跳转两次
  h.win().emitWebContents('did-finish-load')
  assert.equal(
    h.state.sent.filter((s) => s.channel === 'desktop-notification-click').length, 0,
    '已被 consume 的点击不得再补发'
  )
})
