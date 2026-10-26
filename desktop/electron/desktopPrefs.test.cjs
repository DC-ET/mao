'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const {
  defaultDesktopPrefs,
  getDesktopPrefsPath,
  normalizeDesktopPrefs,
  readDesktopPrefs,
  writeDesktopPrefs,
  clearDesktopPrefsCache,
  DEFAULT_GLOBAL_SHORTCUT,
} = require('./desktopPrefs.cjs')

function tempUserData(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mao-desktop-prefs-')))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  clearDesktopPrefsCache()
  return dir
}

test('默认值：关窗托盘化、快捷键 Alt+Shift+M、自启关', () => {
  const prefs = defaultDesktopPrefs()
  assert.equal(prefs.closeToTray, 'tray')
  assert.equal(prefs.trayHintShown, false)
  assert.equal(prefs.globalShortcut, DEFAULT_GLOBAL_SHORTCUT)
  assert.equal(prefs.globalShortcut, 'Alt+Shift+M')
  assert.equal(prefs.autoStart, false)
})

test('文件缺失时读盘返回默认值', (t) => {
  const dir = tempUserData(t)
  const prefs = readDesktopPrefs(dir)
  assert.equal(prefs.closeToTray, 'tray')
  assert.equal(prefs.globalShortcut, 'Alt+Shift+M')
})

test('坏文件（非法 JSON）回退默认值，不抛错', (t) => {
  const dir = tempUserData(t)
  fs.writeFileSync(getDesktopPrefsPath(dir), '{not json')
  const prefs = readDesktopPrefs(dir)
  assert.equal(prefs.closeToTray, 'tray')
  assert.equal(prefs.globalShortcut, 'Alt+Shift+M')
})

test('坏文件（JSON 但类型错误）逐字段回落', (t) => {
  const dir = tempUserData(t)
  fs.writeFileSync(
    getDesktopPrefsPath(dir),
    JSON.stringify({ closeToTray: 'nope', globalShortcut: 42, autoStart: 'yes', trayHintShown: 1 })
  )
  const prefs = readDesktopPrefs(dir)
  assert.equal(prefs.closeToTray, 'tray')
  assert.equal(prefs.globalShortcut, 'Alt+Shift+M')
  assert.equal(prefs.autoStart, false)
  assert.equal(prefs.trayHintShown, false)
})

test('合法文件逐字段读入', (t) => {
  const dir = tempUserData(t)
  fs.writeFileSync(
    getDesktopPrefsPath(dir),
    JSON.stringify({ closeToTray: 'quit', trayHintShown: true, globalShortcut: null, autoStart: true })
  )
  const prefs = readDesktopPrefs(dir)
  assert.equal(prefs.closeToTray, 'quit')
  assert.equal(prefs.trayHintShown, true)
  assert.equal(prefs.globalShortcut, null)
  assert.equal(prefs.autoStart, true)
})

test('写入后立即读到合并结果（缓存刷新）', (t) => {
  const dir = tempUserData(t)
  const first = writeDesktopPrefs(dir, { closeToTray: 'quit' })
  assert.equal(first.ok, true)
  assert.equal(first.prefs.closeToTray, 'quit')
  // 未指定字段保持默认
  assert.equal(first.prefs.globalShortcut, 'Alt+Shift+M')
  const reread = readDesktopPrefs(dir)
  assert.equal(reread.closeToTray, 'quit')

  const second = writeDesktopPrefs(dir, { globalShortcut: null })
  assert.equal(second.prefs.closeToTray, 'quit', '未指定字段保留上次值')
  assert.equal(second.prefs.globalShortcut, null)
  const third = writeDesktopPrefs(dir, { globalShortcut: 'Ctrl+Alt+K' })
  assert.equal(third.prefs.closeToTray, 'quit')
  assert.equal(third.prefs.globalShortcut, 'Ctrl+Alt+K')
})

test('写入为原子写：tmp+rename，无残留临时文件，内容完整可解析', (t) => {
  const dir = tempUserData(t)
  writeDesktopPrefs(dir, { closeToTray: 'quit' })
  const files = fs.readdirSync(dir)
  assert.deepEqual(files, ['desktop-prefs.json'], `不应残留 tmp 文件: ${files}`)
  const raw = fs.readFileSync(getDesktopPrefsPath(dir), 'utf8')
  const parsed = JSON.parse(raw)
  assert.equal(parsed.closeToTray, 'quit')
})

test('连续多次写入内容始终是最后一次的完整 JSON（无半写文件）', (t) => {
  const dir = tempUserData(t)
  for (let i = 0; i < 50; i++) {
    writeDesktopPrefs(dir, { trayHintShown: i % 2 === 0 })
  }
  const parsed = JSON.parse(fs.readFileSync(getDesktopPrefsPath(dir), 'utf8'))
  // 50 次后 i=49 → false
  assert.equal(parsed.trayHintShown, false)
  assert.equal(parsed.closeToTray, 'tray')
})

test('normalizeDesktopPrefs：版本演进只加字段，旧文件缺字段走 ?? default', () => {
  const normalized = normalizeDesktopPrefs({ closeToTray: 'quit' })
  assert.equal(normalized.closeToTray, 'quit')
  assert.equal(normalized.trayHintShown, false)
  assert.equal(normalized.globalShortcut, 'Alt+Shift+M')
  assert.equal(normalized.autoStart, false)
  assert.equal(normalized.version, 1)
})

test('normalizeDesktopPrefs：非对象入参回落默认', () => {
  assert.equal(normalizeDesktopPrefs(null).closeToTray, 'tray')
  assert.equal(normalizeDesktopPrefs('x').closeToTray, 'tray')
  assert.equal(normalizeDesktopPrefs(42).closeToTray, 'tray')
})

test('globalShortcut 空字符串回落默认键，null 表示关闭', () => {
  assert.equal(normalizeDesktopPrefs({ globalShortcut: '' }).globalShortcut, 'Alt+Shift+M')
  assert.equal(normalizeDesktopPrefs({ globalShortcut: '   ' }).globalShortcut, 'Alt+Shift+M')
  assert.equal(normalizeDesktopPrefs({ globalShortcut: null }).globalShortcut, null)
  assert.equal(normalizeDesktopPrefs({ globalShortcut: ' Ctrl+Shift+A ' }).globalShortcut, 'Ctrl+Shift+A')
})

test('写盘后缓存生效：同 dir 二次读盘不重复解析文件（clearDesktopPrefsCache 后可重读）', (t) => {
  const dir = tempUserData(t)
  writeDesktopPrefs(dir, { closeToTray: 'quit' })
  // 绕过写接口直接改文件，缓存未清时应仍返回缓存值
  fs.writeFileSync(getDesktopPrefsPath(dir), JSON.stringify({ closeToTray: 'tray' }))
  assert.equal(readDesktopPrefs(dir).closeToTray, 'quit')
  clearDesktopPrefsCache()
  assert.equal(readDesktopPrefs(dir).closeToTray, 'tray')
  // force 读盘
  clearDesktopPrefsCache()
  writeDesktopPrefs(dir, { closeToTray: 'quit' })
  fs.writeFileSync(getDesktopPrefsPath(dir), JSON.stringify({ closeToTray: 'tray' }))
  assert.equal(readDesktopPrefs(dir, { force: true }).closeToTray, 'tray')
})
