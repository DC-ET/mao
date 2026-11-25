'use strict'

/**
 * file_fetch 委托读取的工作区 containment（方案 2026-11-18 §5.2-1，可单测）。
 * 服务端下发的 workspace + 相对路径在此拼装并校验解析结果仍在 workspace 内；
 * 不沿用 local-read-bytes 的绝对路径直通口子（resolveWorkspacePath 会放行绝对路径），
 * 也不写 currentWorkspace——fetch 是只读操作，不得产生状态副作用。
 *
 * containment 是 realpath 口径（与 agent-cli isWorkspaceWithin 对齐）：root 与目标都先
 * fs.realpathSync 归一，workspace 内的父级目录 symlink（如 screenshots/ → 外部目录）会穿出
 * 词法校验，realpath 后即被拒。字节读取与普通文件 / 符号链接 / 上限校验复用 localFileBytes.cjs。
 */

const fs = require('fs')
const path = require('path')
const { readFileBytes } = require('./localFileBytes.cjs')

/** file_fetch 功能上限（与 backend-ts FILE_FETCH_MAX_BYTES / 渲染层同表）；默认收紧 localFileBytes 的 64MB 通用上限。 */
const FILE_FETCH_MAX_BYTES = 10 * 1024 * 1024

/**
 * 相对路径 → workspace 内绝对路径。
 * 拒绝：绝对路径（含 `/` 开头、盘符）、反斜杠（UNC 与 Windows 分隔符一律不认，`/` 为唯一分隔符）、
 * `.` / `..` 段、空段；拼装后做 realpath containment 校验。
 * @returns {{ path: string } | { error: string }}
 */
function resolveContainedWorkspacePath(workspace, relativePath) {
  if (typeof workspace !== 'string' || workspace.trim() === '') return { error: '缺少工作区路径' }
  if (typeof relativePath !== 'string' || relativePath.trim() === '') return { error: '缺少文件路径' }
  if (relativePath.includes('\\')) return { error: '文件路径不合法' }
  if (relativePath.startsWith('/') || path.isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) {
    return { error: '文件路径不合法' }
  }
  const segments = relativePath.split('/')
  if (segments.some((seg) => seg.length === 0 || seg === '.' || seg === '..' || seg.includes(':'))) {
    return { error: '文件路径不合法' }
  }
  const root = path.resolve(workspace)
  const target = path.resolve(root, ...segments)
  // realpath 归一后比对：父级目录 symlink 逃逸在这里被拒；目标不存在时按读取错误口径返回
  let rootReal
  let targetReal
  try {
    rootReal = fs.realpathSync(root)
  } catch {
    return { error: '工作区路径不存在' }
  }
  try {
    targetReal = fs.realpathSync(target)
  } catch {
    return { error: '文件不存在' }
  }
  const rel = path.relative(rootReal, targetReal)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return { error: '文件路径越界' }
  return { path: targetReal }
}

/**
 * file_fetch 委托读取：containment + readFileBytes（普通文件 / 符号链接 / 上限校验）。
 * @returns {{ bytes: Buffer, size: number } | { error: string }}
 */
function readWorkspaceBytes(workspace, relativePath, options) {
  const resolved = resolveContainedWorkspacePath(workspace, relativePath)
  if (resolved.error) return resolved
  return readFileBytes(resolved.path, { maxBytes: FILE_FETCH_MAX_BYTES, ...options })
}

/**
 * delivery_read 的执行端路径解析（方案 2026-11-18-unified-send-media §6.2）：相对路径，
 * 或「解析后仍在该会话 workspace 内」的绝对路径（send 工具允许 absolute-within-workspace）。
 * containment 是 realpath 口径（`..` / 父级目录 symlink 逃逸都靠 realpath 比对拒绝）；
 * 相对路径的反斜杠与 NUL 直接拒绝，目标本身是符号链接也拒绝（工具约定「非符号链接」）。
 * 反斜杠按平台语义放行：相对路径 `/` 为唯一分隔符；绝对路径在 Windows 上必然含反斜杠，
 * 放行交给 realpath containment 兜底（agent-cli file-fetch.ts 同构，改动须双端同步）。
 * 字节读取改由 localDeliveryStream.cjs 持有句柄按区间读（2026-11-25 R2），这里只做路径解析。
 * @returns {{ path: string } | { error: string }}
 */
function resolveDeliveryWorkspacePath(workspace, filePath) {
  if (typeof workspace !== 'string' || workspace.trim() === '') return { error: '缺少工作区路径' }
  if (typeof filePath !== 'string' || filePath.trim() === '') return { error: '缺少文件路径' }
  if (!path.isAbsolute(filePath) && filePath.includes('\\')) return { error: '文件路径不合法' }
  if (filePath.includes('\0')) return { error: '文件路径不合法' }
  const root = path.resolve(workspace)
  let rootReal
  try {
    rootReal = fs.realpathSync(root)
  } catch {
    return { error: '工作区路径不存在' }
  }
  const target = path.resolve(root, filePath)
  // 目标本身是符号链接直接拒绝（realpath 会跟到目标，之后 lstat 就看不出来了）
  try {
    if (fs.lstatSync(target).isSymbolicLink()) return { error: '不接受符号链接' }
  } catch {
    return { error: '文件不存在' }
  }
  let targetReal
  try {
    targetReal = fs.realpathSync(target)
  } catch {
    return { error: '文件不存在' }
  }
  const rel = path.relative(rootReal, targetReal)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return { error: '文件路径越界' }
  return { path: targetReal }
}

module.exports = { resolveContainedWorkspacePath, readWorkspaceBytes, resolveDeliveryWorkspacePath, FILE_FETCH_MAX_BYTES }
