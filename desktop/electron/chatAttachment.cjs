'use strict'

/**
 * LOCAL 附件拷贝（P1）：发送时把用户拖入/选中的任意文件复制到
 * `~/.mao/attachments/<serverHost>/<sessionId>/`（机器级、按 host 隔离，
 * 仿 ~/.mao/runtime/<host>/<sid>/ 既有约定），返回绝对路径引用 @{...}@。
 *
 * 纯逻辑 + 可注入 fs，node --test 可单测；IPC handler 由 main.cjs 注册。
 * 目标目录是 Mao 自管目录（不涉及工作区），收敛由「basename sanitize +
 * hostKey/sessionId 强校验 + 固定前缀 + home 相对断言」按构造保证。
 */

const fs = require('fs')
const path = require('path')

const ATTACHMENTS_DIR_NAME = '.mao'
const ATTACHMENTS_SUBDIR = 'attachments'
const MAX_NAME_LENGTH = 100
const FALLBACK_NAME = 'attachment'
const DEFAULT_MAX_SIZE_MB = 100
/**
 * 主进程硬封顶：渲染层传入的 maxSizeMb 来自后端上传配置（默认 1024），
 * 不封顶时一个接近 1GB 的附件会把主进程同步阻塞数十秒（应用「未响应」）。
 * 异步拷贝解决阻塞后，此上限仅防病态配置（如 TB 级）放行超大文件。
 */
const MAIN_PROCESS_MAX_SIZE_MB = 512
const UNIQUE_NAME_MAX_ATTEMPTS = 10000

/** Windows 保留设备名（不分大小写；CON.txt 这类带扩展名的同样保留） */
const WINDOWS_RESERVED = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\..*)?$/i
/** 控制字符（含 \t \n \r）一律剥除，避免文件名里藏不可见字符 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g

function truncateName(name) {
  if (name.length <= MAX_NAME_LENGTH) return name
  const ext = path.extname(name)
  if (ext.length >= MAX_NAME_LENGTH) return name.slice(0, MAX_NAME_LENGTH)
  const stem = name.slice(0, name.length - ext.length)
  return stem.slice(0, MAX_NAME_LENGTH - ext.length) + ext
}

/**
 * 文件名 sanitize：basename 化、剥控制字符与首尾点/空格、Windows 保留名加
 * `_` 前缀、超长截断（保留扩展名，总长 ≤100）。幂等。
 * @param {string} raw
 * @returns {string}
 */
function sanitizeAttachmentName(raw) {
  let name = String(raw ?? '')
  // basename 化：只取最后一段（POSIX / 与 Windows \ 都算分隔符）
  const segments = name.split(/[\\/]/)
  name = segments[segments.length - 1] ?? ''
  name = name.replace(CONTROL_CHARS, '')
  name = name.replace(/^\.+/, '').replace(/[. ]+$/, '')
  if (!name) return FALLBACK_NAME
  const stem = name.slice(0, name.length - path.extname(name).length)
  if (WINDOWS_RESERVED.test(stem)) {
    name = `_${name}`
  }
  name = truncateName(name)
  // 截断可能重新露出尾点/尾空格，再收一次；仍为空则回落
  name = name.replace(/[. ]+$/, '')
  if (!name) return FALLBACK_NAME
  return name
}

/**
 * hostKey 强校验：非空、无路径分隔符、不是 . / ..、无控制字符。
 * 防 `../1` 之类把附件写到别的 host 目录甚至越出 attachments 根。
 * @param {string} hostKey
 * @returns {boolean}
 */
function isValidHostKey(hostKey) {
  if (typeof hostKey !== 'string') return false
  if (!hostKey || hostKey !== hostKey.trim()) return false
  if (/[\\/]/.test(hostKey)) return false
  if (hostKey === '.' || hostKey === '..') return false
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(hostKey)) return false
  return true
}

/**
 * sessionId 强校验：正整数（接受数字字符串，拒绝 `1/../../x` 等注入）。
 * @param {number|string} sessionId
 * @returns {boolean}
 */
function isValidSessionId(sessionId) {
  if (typeof sessionId === 'number') return Number.isSafeInteger(sessionId) && sessionId > 0
  if (typeof sessionId !== 'string') return false
  if (!/^\d+$/.test(sessionId.trim())) return false
  const parsed = Number(sessionId.trim())
  return Number.isSafeInteger(parsed) && parsed > 0
}

/**
 * 解析附件目标路径：`<home>/.mao/attachments/<hostKey>/<sessionId>/<name>`，
 * 并对 home 做 relative 断言不出界（home 自身是符号链接时先 realpath）。
 *
 * @param {string} homeDir 用户主目录（os.homedir()）
 * @param {string} hostKey 服务器 host 命名空间（主进程 getServerHostKey()）
 * @param {number|string} sessionId 会话 ID
 * @param {string} name 原始文件名（内部会 sanitize）
 * @param {{ fsImpl?: typeof fs }} [deps]
 * @returns {string} 绝对路径（已 normalize，未展开 ~）
 */
function resolveAttachmentTarget(homeDir, hostKey, sessionId, name, deps = {}) {
  const fsImpl = deps.fsImpl || fs
  if (!isValidHostKey(hostKey)) {
    throw new Error('服务器标识无效，无法确定附件目录')
  }
  if (!isValidSessionId(sessionId)) {
    throw new Error('会话无效')
  }
  const safeName = sanitizeAttachmentName(name)
  if (!safeName) {
    throw new Error('文件名无效')
  }

  const home = path.resolve(String(homeDir || ''))
  let realHome = home
  try {
    realHome = fsImpl.realpathSync(home)
  } catch {
    // home 不存在等异常交由后续 existsSync/写入路径报出可读错误
  }
  const maoDir = path.join(realHome, ATTACHMENTS_DIR_NAME)
  if (fsImpl.existsSync(maoDir) && !fsImpl.statSync(maoDir).isDirectory()) {
    throw new Error(`~/${ATTACHMENTS_DIR_NAME} 已存在且不是目录，请手动检查后重试`)
  }

  const target = path.resolve(
    realHome,
    ATTACHMENTS_DIR_NAME,
    ATTACHMENTS_SUBDIR,
    hostKey,
    String(sessionId).trim(),
    safeName
  )
  const rel = path.relative(realHome, target)
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error('附件目录必须位于 ~/.mao/attachments 下')
  }
  return target
}

/**
 * 目录内重名规避：`stem-1.ext`、`stem-2.ext`… 确定性递增。
 * @param {string} dir
 * @param {string} name
 * @param {{ fsImpl?: typeof fs }} [deps]
 * @returns {string}
 */
function uniqueName(dir, name, deps = {}) {
  const fsImpl = deps.fsImpl || fs
  if (!fsImpl.existsSync(path.join(dir, name))) return name
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let i = 1; i <= UNIQUE_NAME_MAX_ATTEMPTS; i++) {
    const candidate = `${stem}-${i}${ext}`
    if (!fsImpl.existsSync(path.join(dir, candidate))) return candidate
  }
  throw new Error('同名文件过多，请重命名后重试')
}

/**
 * 有效大小上限：主进程对渲染层传入值做硬封顶。
 * @param {number} [maxSizeMb]
 * @returns {number}
 */
function effectiveMaxSizeMb(maxSizeMb) {
  const base = Number.isFinite(maxSizeMb) && maxSizeMb > 0
    ? Number(maxSizeMb)
    : DEFAULT_MAX_SIZE_MB
  return Math.min(base, MAIN_PROCESS_MAX_SIZE_MB)
}

/**
 * 校验 + 落点解析（同步、廉价）：lstat 复核类型与大小、解析目标路径、重名规避。
 * 拷文件本身（唯一的重活）由调用方选择同步/异步执行。
 *
 * @param {{
 *   sourcePath: string,
 *   sessionId: number|string,
 *   maxSizeMb?: number,
 *   homeDir?: string,
 *   hostKey: string,
 *   fsImpl?: typeof fs,
 * }} params
 * @returns {{ ok: true, sourcePath: string, dir: string, finalPath: string } | { ok: false, error: string }}
 */
function prepareLocalAttachmentCopy(params) {
  const fsImpl = params.fsImpl || fs
  const sourcePath = typeof params.sourcePath === 'string' ? params.sourcePath : ''
  const maxSizeMb = effectiveMaxSizeMb(params.maxSizeMb)

  try {
    if (!sourcePath) return { ok: false, error: '文件路径无效' }
    if (!isValidSessionId(params.sessionId)) return { ok: false, error: '会话无效' }

    let stat
    try {
      // lstat 不跟随符号链接：symlink → 文件也会被 isSymbolicLink 抓到并拒绝
      stat = fsImpl.lstatSync(sourcePath)
    } catch (e) {
      if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
        return { ok: false, error: '文件已不存在，可能已被移动或删除' }
      }
      if (e && e.code === 'EACCES') {
        return { ok: false, error: '没有读取该文件的权限' }
      }
      return { ok: false, error: `无法读取文件：${e?.message || '未知错误'}` }
    }
    if (stat.isDirectory()) return { ok: false, error: '请选择文件，暂不支持发送文件夹' }
    if (stat.isSymbolicLink()) return { ok: false, error: '不支持符号链接，请选择实际文件' }
    if (!stat.isFile()) return { ok: false, error: '请选择普通文件' }
    if (stat.size === 0) return { ok: false, error: '文件为空，无法发送' }
    if (stat.size > maxSizeMb * 1024 * 1024) {
      return { ok: false, error: `文件超过 ${maxSizeMb}MB 限制` }
    }

    const target = resolveAttachmentTarget(params.homeDir, params.hostKey, params.sessionId, path.basename(sourcePath), { fsImpl })
    const dir = path.dirname(target)
    const finalName = uniqueName(dir, path.basename(target), { fsImpl })
    const finalPath = path.join(dir, finalName)
    return { ok: true, sourcePath, dir, finalPath }
  } catch (e) {
    return { ok: false, error: e?.message || '拷贝失败' }
  }
}

/**
 * 拷贝单个附件到会话目录（LOCAL 懒拷贝的落点）。同步版，保留供测试与兼容调用。
 * 防御纵深：主进程侧重新 lstat（不跟随符号链接）复核类型与大小。
 *
 * @param {{
 *   sourcePath: string,
 *   sessionId: number|string,
 *   maxSizeMb?: number,
 *   homeDir?: string,
 *   hostKey: string,
 *   fsImpl?: typeof fs,
 * }} params
 * @returns {{ ok: true, absolutePath: string } | { ok: false, error: string }}
 */
function copyLocalAttachment(params) {
  const fsImpl = params.fsImpl || fs
  const prepared = prepareLocalAttachmentCopy(params)
  if (!prepared.ok) return prepared
  try {
    fsImpl.mkdirSync(prepared.dir, { recursive: true })
    fsImpl.copyFileSync(prepared.sourcePath, prepared.finalPath)
    return { ok: true, absolutePath: prepared.finalPath }
  } catch (e) {
    return { ok: false, error: e?.message || '拷贝失败' }
  }
}

/**
 * 异步版拷贝（IPC 默认路径）：大文件的 copyFile 不再阻塞主进程事件循环，
 * 避免拖入大附件时整个应用卡死/「未响应」。校验逻辑与同步版完全一致。
 *
 * @param {{
 *   sourcePath: string,
 *   sessionId: number|string,
 *   maxSizeMb?: number,
 *   homeDir?: string,
 *   hostKey: string,
 *   fsImpl?: typeof fs,
 * }} params
 * @returns {Promise<{ ok: true, absolutePath: string } | { ok: false, error: string }>}
 */
async function copyLocalAttachmentAsync(params) {
  const fsImpl = params.fsImpl || fs
  const prepared = prepareLocalAttachmentCopy(params)
  if (!prepared.ok) return prepared
  try {
    fsImpl.mkdirSync(prepared.dir, { recursive: true })
    const promises = fsImpl.promises || fs.promises
    await promises.copyFile(prepared.sourcePath, prepared.finalPath)
    return { ok: true, absolutePath: prepared.finalPath }
  } catch (e) {
    return { ok: false, error: e?.message || '拷贝失败' }
  }
}

/**
 * 文本落盘（dump_user_messages / 粘贴附件转文件）：把文本写到
 * `~/.mao/attachments/<hostKey>/<sessionId>/<fileName>`，返回本机绝对路径。
 *
 * 同名处理由 `dedupe` 决定（缺省 true，与附件拷贝同语义：追加 `-1`、`-2` 副本）：
 * 渲染层粘贴转出的 `pasted-text-N.txt` 必须避重，否则同会话第二段长文本会覆盖第一段，
 * 让历史消息里的 `@{...pasted-text-1.txt}@` 静默指向新内容；`dump_user_messages`
 * 的文件名由消息 id 决定，显式传 `dedupe:false` 保持按 id 幂等覆盖。
 * 落点仍走 resolveAttachmentTarget 的 sanitize + host/session 强校验 + home 相对断言。
 *
 * @param {{
 *   fileName: string,
 *   content: string,
 *   sessionId: number|string,
 *   maxSizeMb?: number,
 *   dedupe?: boolean,
 *   homeDir?: string,
 *   hostKey: string,
 *   fsImpl?: typeof fs,
 * }} params
 * @returns {Promise<{ ok: true, absolutePath: string, bytes: number } | { ok: false, error: string }>}
 */
async function writeLocalTextFileAsync(params) {
  const fsImpl = params.fsImpl || fs
  try {
    if (typeof params.fileName !== 'string' || params.fileName.trim() === '') {
      return { ok: false, error: '文件名无效' }
    }
    if (typeof params.content !== 'string') return { ok: false, error: '文本内容无效' }
    const maxSizeMb = effectiveMaxSizeMb(params.maxSizeMb)
    const bytes = Buffer.byteLength(params.content, 'utf8')
    if (bytes > maxSizeMb * 1024 * 1024) {
      return { ok: false, error: `文本超过 ${maxSizeMb}MB 限制` }
    }
    const dedupe = params.dedupe !== false
    const target = resolveAttachmentTarget(params.homeDir, params.hostKey, params.sessionId, params.fileName, { fsImpl })
    const dir = path.dirname(target)
    fsImpl.mkdirSync(dir, { recursive: true })
    const finalName = dedupe ? uniqueName(dir, path.basename(target), { fsImpl }) : path.basename(target)
    const finalPath = path.join(dir, finalName)
    const promises = fsImpl.promises || fs.promises
    await promises.writeFile(finalPath, params.content, 'utf8')
    return { ok: true, absolutePath: finalPath, bytes }
  } catch (e) {
    return { ok: false, error: e?.message || '写入失败' }
  }
}

module.exports = {
  ATTACHMENTS_DIR_NAME,
  ATTACHMENTS_SUBDIR,
  MAX_NAME_LENGTH,
  DEFAULT_MAX_SIZE_MB,
  MAIN_PROCESS_MAX_SIZE_MB,
  sanitizeAttachmentName,
  isValidHostKey,
  isValidSessionId,
  resolveAttachmentTarget,
  uniqueName,
  prepareLocalAttachmentCopy,
  copyLocalAttachment,
  copyLocalAttachmentAsync,
  writeLocalTextFileAsync,
}
