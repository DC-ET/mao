'use strict'

/**
 * 桌面偏好（P2/P3）：机器级（不随服务器切换、登出不清），存 userData/desktop-prefs.json。
 * 读时内存缓存、写时 tmp+rename 原子写（serverConfig.cjs 为直写无缓存，本模块按需加固）。
 * 坏文件回退默认值，不阻断启动；版本演进只加字段，用 ?? default 兼容。
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const PREFS_VERSION = 1
const CLOSE_MODES = ['quit', 'tray']
const DEFAULT_GLOBAL_SHORTCUT = 'Alt+Shift+M'
// 稳定设备 ID（跨会话委托执行端）：本机生成、只增不改；字符集与后端校验白名单一致
// （技术方案 2026-11-05 §4.2，UUID 形态天然满足）。
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/** 生成新的设备 ID（UUID v4，36 字符，命中白名单）。 */
function generateDeviceId() {
  return crypto.randomUUID()
}

function defaultDesktopPrefs() {
  return {
    version: PREFS_VERSION,
    closeToTray: 'tray',
    trayHintShown: false,
    globalShortcut: DEFAULT_GLOBAL_SHORTCUT,
    autoStart: false,
    deviceId: null,
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
    deviceId: typeof data.deviceId === 'string' && DEVICE_ID_PATTERN.test(data.deviceId.trim())
      ? data.deviceId.trim()
      : null,
  }
}

/** @type {ReturnType<typeof defaultDesktopPrefs> | null} */
let prefsCache = null

/** 原子写偏好文件（tmp + rename）。调用方保证 prefs 已归一化。 */
function persistDesktopPrefs(userDataDir, prefs) {
  const filePath = getDesktopPrefsPath(userDataDir)
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(prefs, null, 2), 'utf8')
  fs.renameSync(tmpPath, filePath)
}

/**
 * 读取偏好（带内存缓存）。文件缺失 / 损坏 → 默认值。
 * 设备 ID 缺失时先在内存生成（同进程内稳定）；需要落盘时调用 ensureDesktopDeviceId——
 * 读路径不写盘，避免「仅查看偏好」就凭空创建配置文件。
 * @param {string} userDataDir
 * @param {{ force?: boolean }} [options]
 */
function readDesktopPrefs(userDataDir, options = {}) {
  if (prefsCache && !options.force) return prefsCache
  const filePath = getDesktopPrefsPath(userDataDir)
  let prefs
  try {
    if (!fs.existsSync(filePath)) {
      prefs = defaultDesktopPrefs()
    } else {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      prefs = normalizeDesktopPrefs(data)
    }
  } catch {
    prefs = defaultDesktopPrefs()
  }
  if (prefs.deviceId == null) {
    prefs = { ...prefs, deviceId: generateDeviceId() }
  }
  prefsCache = prefs
  return prefsCache
}

/**
 * 确保设备 ID 已落盘（技术方案 2026-11-05 §4.2）：首次读取/旧版本升级后把当前
 * 内存中的设备 ID 写回偏好文件，之后每次启动都稳定复用。
 * @param {string} userDataDir
 * @returns {string} 稳定的设备 ID
 */
function ensureDesktopDeviceId(userDataDir) {
  const prefs = readDesktopPrefs(userDataDir)
  const deviceId = prefs.deviceId ?? generateDeviceId()
  try {
    persistDesktopPrefs(userDataDir, { ...prefs, deviceId })
  } catch {
    // 写盘失败不阻断启动：本次运行使用内存值，下次再补
  }
  const next = { ...prefs, deviceId }
  prefsCache = next
  return deviceId
}

/**
 * 合并写入偏好（tmp + rename 原子写），并刷新缓存。
 * deviceId 由本机生成，patch 不可改写（不可改绑的设备侧前提）。
 * @param {string} userDataDir
 * @param {Partial<ReturnType<typeof defaultDesktopPrefs>>} patch
 * @returns {{ ok: true, prefs: ReturnType<typeof defaultDesktopPrefs> }}
 */
function writeDesktopPrefs(userDataDir, patch) {
  const current = readDesktopPrefs(userDataDir)
  const merged = normalizeDesktopPrefs({
    ...current,
    ...(patch && typeof patch === 'object' ? patch : {}),
    deviceId: current.deviceId ?? generateDeviceId(),
  })
  persistDesktopPrefs(userDataDir, merged)
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
  DEVICE_ID_PATTERN,
  defaultDesktopPrefs,
  generateDeviceId,
  getDesktopPrefsPath,
  normalizeDesktopPrefs,
  readDesktopPrefs,
  writeDesktopPrefs,
  ensureDesktopDeviceId,
  clearDesktopPrefsCache,
}
