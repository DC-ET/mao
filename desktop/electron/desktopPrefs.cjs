'use strict'

/**
 * 桌面偏好（P2/P3）：机器级（不随服务器切换、登出不清），存 userData/desktop-prefs.json。
 * 读时内存缓存、写时 tmp+rename 原子写（serverConfig.cjs 为直写无缓存，本模块按需加固）。
 * 坏文件回退默认值，不阻断启动；版本演进只加字段，用 ?? default 兼容。
 */

const fs = require('fs')
const path = require('path')

const PREFS_VERSION = 1
const CLOSE_MODES = ['quit', 'tray']
const DEFAULT_GLOBAL_SHORTCUT = 'Alt+Shift+M'

function defaultDesktopPrefs() {
  return {
    version: PREFS_VERSION,
    closeToTray: 'tray',
    trayHintShown: false,
    globalShortcut: DEFAULT_GLOBAL_SHORTCUT,
    autoStart: false,
  }
}

function getDesktopPrefsPath(userDataDir) {
  return path.join(String(userDataDir || ''), 'desktop-prefs.json')
}

/**
 * 字段归一化：非法值逐个回落默认（不是整体回退），
 * 保证旧版本/手改文件缺字段时行为可预期。
 * @param {unknown} raw
 */
function normalizeDesktopPrefs(raw) {
  const defaults = defaultDesktopPrefs()
  const data = raw && typeof raw === 'object' ? raw : {}
  const closeToTray = CLOSE_MODES.includes(data.closeToTray) ? data.closeToTray : defaults.closeToTray
  let globalShortcut = defaults.globalShortcut
  if (data.globalShortcut === null) {
    globalShortcut = null
  } else if (typeof data.globalShortcut === 'string' && data.globalShortcut.trim() !== '') {
    globalShortcut = data.globalShortcut.trim()
  }
  return {
    version: PREFS_VERSION,
    closeToTray,
    trayHintShown: data.trayHintShown === true,
    globalShortcut,
    autoStart: data.autoStart === true,
  }
}

/** @type {ReturnType<typeof defaultDesktopPrefs> | null} */
let prefsCache = null

/**
 * 读取偏好（带内存缓存）。文件缺失 / 损坏 → 默认值。
 * @param {string} userDataDir
 * @param {{ force?: boolean }} [options]
 */
function readDesktopPrefs(userDataDir, options = {}) {
  if (prefsCache && !options.force) return prefsCache
  const filePath = getDesktopPrefsPath(userDataDir)
  try {
    if (!fs.existsSync(filePath)) {
      prefsCache = defaultDesktopPrefs()
      return prefsCache
    }
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    prefsCache = normalizeDesktopPrefs(data)
  } catch {
    prefsCache = defaultDesktopPrefs()
  }
  return prefsCache
}

/**
 * 合并写入偏好（tmp + rename 原子写），并刷新缓存。
 * @param {string} userDataDir
 * @param {Partial<ReturnType<typeof defaultDesktopPrefs>>} patch
 * @returns {{ ok: true, prefs: ReturnType<typeof defaultDesktopPrefs> }}
 */
function writeDesktopPrefs(userDataDir, patch) {
  const current = readDesktopPrefs(userDataDir)
  const merged = normalizeDesktopPrefs({
    ...current,
    ...(patch && typeof patch === 'object' ? patch : {}),
  })
  const filePath = getDesktopPrefsPath(userDataDir)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(merged, null, 2), 'utf8')
  fs.renameSync(tmpPath, filePath)
  prefsCache = merged
  return { ok: true, prefs: merged }
}

/** 测试辅助：清掉模块级缓存（userDataDir 在每个用例间变化）。 */
function clearDesktopPrefsCache() {
  prefsCache = null
}

module.exports = {
  PREFS_VERSION,
  CLOSE_MODES,
  DEFAULT_GLOBAL_SHORTCUT,
  defaultDesktopPrefs,
  getDesktopPrefsPath,
  normalizeDesktopPrefs,
  readDesktopPrefs,
  writeDesktopPrefs,
  clearDesktopPrefsCache,
}
