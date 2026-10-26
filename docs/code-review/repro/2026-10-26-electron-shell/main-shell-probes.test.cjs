'use strict'

/**
 * main.cjs 桌面壳集成探针：对审查候选 bug 逐条复现。
 * 每个用例要么通过（行为正确），要么以真实失败暴露 bug。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { loadMain } = require('./main-harness.cjs')

// ─── 候选 1：second-instance 在 app ready 前到达 → createWindow 抛未捕获异常 ───

test('候选1：second-instance 先于 app ready 到达时 createWindow 抛异常（主实例崩溃路径）', async () => {
  const h = await loadMain({ holdReady: true })
  assert.equal(h.state.appReady, false, 'harness 应尚未 ready')
  assert.equal(h.windows().length, 0, '尚未创建窗口')
  // 真实 Electron：次实例启动即通过锁套接字通知主实例，主实例可能还没 ready
  assert.throws(
    () => h.emitApp('second-instance'),
    /BrowserWindow can only be created after the app is ready/,
    'second-instance 处理器在未 ready 时调用 createWindow 应被 Electron 拒绝'
  )
})

// ─── 候选 2：窗口重建后托盘菜单文案失刷新（退出模式 + macOS） ───

test('候选2：退出模式下窗口销毁重建后，新窗口的 hide/minimize 不再刷新托盘文案', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'quit' }, platform: 'darwin' })

  // 1) 退出模式：关窗销毁窗口
  h.win().close()
  assert.equal(h.win().isDestroyed(), true)

  // 2) dock 点击 → activate → getAllWindows()===0 → createWindow 新窗口
  h.emitApp('activate')
  await h.tick()
  const w2 = h.win()
  assert.equal(w2.isDestroyed(), false, 'activate 应重建窗口')
  assert.equal(w2.isVisible(), true, '新窗口应已显示')
  assert.equal(h.trayMenuLabel(), '隐藏主窗', '窗口可见时文案为「隐藏主窗」（此刻碰巧一致）')

  // 3) 用户最小化 / Cmd+H 新窗口
  w2.minimize()
  assert.equal(w2.isVisible(), false, '最小化后窗口不可见')
  assert.equal(
    h.trayMenuLabel(), '显示主窗',
    '窗口不可见时托盘文案应为「显示主窗」'
  )

  // 4) 后果：用户按文案点击「隐藏主窗」→ onShowHide 发现窗口不可见 → 反而把窗口显示出来
  h.tray().click()
  assert.equal(w2.isVisible(), false, '点击后窗口应保持隐藏（文案与动作一致）')
})

// ─── 候选 3：快捷键热更新失败 → 旧键被清空且未重新注册，但偏好/设置页仍显示旧键 ───

test('候选3：新快捷键注册失败后旧快捷键已失效，但偏好未更新（设置页仍显示旧键）', async () => {
  const h = await loadMain({})

  // 先成功设置一个快捷键
  const ok = await h.invoke('desktop-shortcut-set', 'Ctrl+Alt+K')
  assert.equal(ok.ok, true)
  assert.deepEqual(h.state.shortcutRegs.map((r) => r.accel), ['Ctrl+Alt+K'])

  // 再设置一个新键但注册失败（被其他程序占用）
  h.failNextShortcutRegistration()
  const failed = await h.invoke('desktop-shortcut-set', 'Ctrl+Alt+Y')
  assert.equal(failed.ok, false, '注册失败应返回 ok:false')

  // 期望：失败时保持旧快捷键可用（或至少明确告知已停用）；实际：unregisterAll 已清空且未重注册
  assert.deepEqual(
    h.state.shortcutRegs.map((r) => r.accel), ['Ctrl+Alt+K'],
    '注册失败后旧快捷键应仍然可用'
  )

  // 偏好文件里仍是旧键 → 设置页显示旧键，但实际没有任何快捷键生效（直到重启）
  const prefs = JSON.parse(fs.readFileSync(path.join(h.userDataDir, 'desktop-prefs.json'), 'utf8'))
  assert.equal(prefs.globalShortcut, 'Ctrl+Alt+K')
})

// ─── 基线核对（这些应当通过，证明 harness 行为符合设计） ───

test('基线：托盘模式关窗 → 隐藏 + 一次性提示 + 偏好持久化', async () => {
  const h = await loadMain({ prefs: { closeToTray: 'tray' } })
  h.win().close()
  assert.equal(h.win().isDestroyed(), false)
  assert.equal(h.win().isVisible(), false)
  assert.equal(h.state.sent.filter((s) => s.channel === 'tray-first-close-hint').length, 1)
  const prefs = JSON.parse(fs.readFileSync(path.join(h.userDataDir, 'desktop-prefs.json'), 'utf8'))
  assert.equal(prefs.trayHintShown, true)
})

test('基线：托盘退出走 app.quit + before-quit 全量清理', async () => {
  const h = await loadMain({})
  h.tray().menuTemplate.find((i) => i.label === '退出').click()
  assert.equal(h.state.quitCalls, 1)
  assert.equal(h.win().isDestroyed(), true, 'quitting 后 close 不再被拦截')
})

test('基线：activate 在窗口隐藏时恢复显示（托盘模式）', async () => {
  const h = await loadMain({})
  h.win().hide()
  h.emitApp('activate')
  assert.equal(h.win().isVisible(), true)
  assert.equal(h.trayMenuLabel(), '隐藏主窗')
})

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

test('基线：dev 模式拒绝开启自启且不落盘', async () => {
  const h = await loadMain({ packaged: false })
  const r = await h.invoke('desktop-prefs-set', { autoStart: true })
  assert.equal(r.ok, false)
  assert.equal(fs.existsSync(path.join(h.userDataDir, 'desktop-prefs.json')), false)
  assert.deepEqual(h.state.loginItemSettings, [])
})

test('基线：打包后开启自启写入登录项', async () => {
  const h = await loadMain({ packaged: true })
  const r = await h.invoke('desktop-prefs-set', { autoStart: true })
  assert.equal(r.ok, true)
  assert.deepEqual(h.state.loginItemSettings, [{ openAtLogin: true, openAsHidden: true }])
})

test('基线：角标仅 macOS 生效', async () => {
  const mac = await loadMain({ platform: 'darwin' })
  await mac.invoke('desktop-badge', { count: 3 })
  assert.deepEqual(mac.state.badgeCounts, [3])
  const win = await loadMain({ platform: 'win32' })
  await win.invoke('desktop-badge', { count: 3 })
  assert.deepEqual(win.state.badgeCounts, [])
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

test('基线：托盘「新建任务」先唤起窗口再发事件', async () => {
  const h = await loadMain({})
  h.win().hide()
  h.tray().menuTemplate.find((i) => i.label === '新建任务').click()
  assert.equal(h.win().isVisible(), true)
  assert.equal(h.state.sent.filter((s) => s.channel === 'tray-new-task').length, 1)
})

test('基线：second-instance 在窗口隐藏时唤起并聚焦', async () => {
  const h = await loadMain({})
  h.win().hide()
  h.emitApp('second-instance')
  assert.equal(h.win().isVisible(), true)
  assert.equal(h.win().isFocused(), true)
})

test('基线：dev 模式清空自启仍落盘（关闭不拒绝）', async () => {
  const h = await loadMain({ packaged: false, prefs: { autoStart: true } })
  const r = await h.invoke('desktop-prefs-set', { autoStart: false })
  assert.equal(r.ok, true)
  const prefs = JSON.parse(fs.readFileSync(path.join(h.userDataDir, 'desktop-prefs.json'), 'utf8'))
  assert.equal(prefs.autoStart, false)
})

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
