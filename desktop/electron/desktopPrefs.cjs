'use strict'

/**
 * 桌面偏好（P2/P3）：机器级（不随服务器切换、登出不清），存 userData/desktop-prefs.json。
 * 读时内存缓存、写时 tmp+rename 原子写（serverConfig.cjs 为直写无缓存，本模块按需加固）。
 * 坏文件回退默认值，不阻断启动；版本演进只加字段，用 ?? default 兼容。
 */

const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const PREFS_VERSION = 1
const CLOSE_MODES = ['quit', 'tray']
const DEFAULT_GLOBAL_SHORTCUT = 'Alt+Shift+M'
// 稳定设备 ID（跨会话委托执行端）：本机生成、只增不改；字符集与后端校验白名单一致
// （技术方案 2026-11-05 §4.2，UUID 形态天然满足）。
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

/**
 * 本机共享设备身份文件：与 mao-agent 的 `~/.mao/agent-cli/device.json` 同一个路径。
 * 桌面端与 CLI 曾各自生成 deviceId（两套实现、同机也不同），导致「CLI 建的 LOCAL 会话」
 * 绑定 CLI 设备后，桌面端被排除在定向投递之外、技能同步无人响应。统一到同一文件后，
 * 同机两端天然是同一个设备，定向投递与接管都不再需要兜底广播。
 * CLI 未安装 / 文件不存在时由桌面端创建，之后 CLI 直接复用。
 */
const SHARED_DEVICE_FILE = path.join(os.homedir(), '.mao', 'agent-cli', 'device.json')

/**
 * 共享设备文件路径解析：默认 `~/.mao/agent-cli/device.json`（与 mao-agent 一致）。
 * 测试可注入 HOME 环境变量或传入 userDataDir 之外的自定义 home 来隔离，
 * 避免污染真实用户目录。这里显式支持 MAO_TEST_HOME 覆盖，供单测使用。
 */
function sharedDeviceFilePath() {
  const testHome = process.env.MAO_TEST_HOME
  if (typeof testHome === 'string' && testHome.trim() !== '') {
    return path.join(testHome.trim(), '.mao', 'agent-cli', 'device.json')
  }
  return SHARED_DEVICE_FILE
}

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
 * 确保设备 ID 已落盘（技术方案 2026-11-05 §4.2）：优先复用与 mao-agent 共享的
 * `~/.mao/agent-cli/device.json`；该文件不存在或不可用时回落到桌面自己的偏好文件，
 * 并在可用时把回落值同步进共享文件（CLI 之后直接读到同一个 ID）。
 * @param {string} userDataDir
 * @returns {string} 稳定的设备 ID
 */
function ensureDesktopDeviceId(userDataDir) {
  const shared = readSharedDeviceId()
  if (shared != null) {
    // 共享文件已存在（CLI 装过 / 桌面端曾写过）：以它为准，桌面偏好里的旧值作废。
    // 直接 persist：writeDesktopPrefs 会用 current.deviceId 覆盖 patch（「不可改绑」约束），
    // 而这里正是要改绑到共享值。
    const prefs = { ...readDesktopPrefs(userDataDir), deviceId: shared }
    try {
      persistDesktopPrefs(userDataDir, prefs)
    } catch {
      // 写盘失败不阻断启动：本次运行使用内存值，下次再补
    }
    prefsCache = prefs
    return shared
  }
  const prefs = readDesktopPrefs(userDataDir)
  const deviceId = prefs.deviceId ?? generateDeviceId()
  try {
    persistDesktopPrefs(userDataDir, { ...prefs, deviceId })
  } catch {
    // 写盘失败不阻断启动：本次运行使用内存值，下次再补
  }
  const next = { ...prefs, deviceId }
  prefsCache = next
  writeSharedDeviceId(deviceId)
  return deviceId
}

/** 读取共享设备身份文件里的 deviceId；缺失 / 损坏 / 非法一律返回 null。 */
function readSharedDeviceId() {
  try {
    const raw = JSON.parse(fs.readFileSync(sharedDeviceFilePath(), 'utf8'))
    const id = typeof raw?.id === 'string' ? raw.id.trim() : ''
    return DEVICE_ID_PATTERN.test(id) ? id : null
  } catch {
    return null
  }
}

/**
 * 把桌面端生成的设备 ID 写进共享文件（tmp + rename 原子写），让 mao-agent 之后复用。
 * 写入失败不影响本次运行：桌面端仍用自己的偏好文件值，只是同机两端暂时不一致。
 */
function writeSharedDeviceId(deviceId) {
  writeSharedDeviceFile({ id: deviceId })
}

/** 合并写入共享设备文件：保留已有字段，只更新 id。 */
function writeSharedDeviceFile(patch) {
  try {
    const id = typeof patch?.id === 'string' && DEVICE_ID_PATTERN.test(patch.id.trim())
      ? patch.id.trim()
      : null
    if (id == null) return
    fs.mkdirSync(path.dirname(sharedDeviceFilePath()), { recursive: true, mode: 0o700 })
    const shared = sharedDeviceFilePath()
    const tmp = `${shared}.${process.pid}.tmp`
    const payload = { id }
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
    fs.renameSync(tmp, sharedDeviceFilePath())
  } catch {
    // ignore：CLI 不存在共享文件时会自己生成一个（两端不一致，由设备族广播兜底）
  }
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
