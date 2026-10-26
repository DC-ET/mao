'use strict'
const { loadMain } = require('./main-harness.cjs')
;(async () => {
  const h = await loadMain({ prefs: { closeToTray: 'quit' }, platform: 'darwin' })
  h.win().close()                       // 退出模式：销毁
  h.emitApp('activate'); await h.tick() // dock 点击重建
  const w2 = h.win()
  w2.minimize()                          // 用户最小化新窗口
  console.log('最小化后窗口可见:', w2.isVisible())
  console.log('托盘文案(应为「显示主窗」):', h.trayMenuLabel())
  h.tray().click()                       // 用户按文案「隐藏主窗」点击
  console.log('点击后窗口可见(用户意图是隐藏, 结果反而):', w2.isVisible())
  console.log('点击后托盘文案:', h.trayMenuLabel())
})().catch(e => { console.error('ERR', e); process.exit(1) })
