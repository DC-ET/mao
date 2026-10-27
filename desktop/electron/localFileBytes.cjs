'use strict'

/**
 * LOCAL 模式二进制字节读取（技术方案 §5.2）：zip / xlsx / docx / 媒体预览的取数通道。
 * 路径解析留在 main.cjs（与 local-read-file 共用 resolveWorkspacePath，不建第二套），
 * 本模块只承载可单测的类型校验 / 大小上限 / 读取逻辑（localShell.cjs 同款拆分范式）。
 */

const fs = require('fs')

/** 技术方案 §5.2：LOCAL_READ_BYTES_MAX = 64MB（覆盖媒体阈值 50MB 并留余量） */
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024

function formatBytes(n) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${n}B`
}

/**
 * 读取本地文件原始字节。
 * @param resolvedPath 已由调用方（main.cjs resolveWorkspacePath）解析的绝对路径
 * @returns {{ bytes: Buffer, size: number } | { error: string }}
 */
function readFileBytes(resolvedPath, { maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const lst = fs.lstatSync(resolvedPath)
  if (!lst.isFile() || lst.isSymbolicLink()) {
    return { error: '不是普通文件或为符号链接，拒绝读取' }
  }
  if (lst.size > maxBytes) {
    return { error: `文件过大（${formatBytes(lst.size)}），预览上限为 ${formatBytes(maxBytes)}` }
  }
  const bytes = fs.readFileSync(resolvedPath)
  return { bytes, size: bytes.length }
}

module.exports = { readFileBytes, DEFAULT_MAX_BYTES }
