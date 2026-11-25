'use strict'

/**
 * delivery_read 的主进程读取句柄（技术方案 2026-11-25-send-file-1gb R2）。
 *
 * 服务端按 512KB × 8 片窗口拉取：open 校验路径并返回 size / mtimeMs，read 按 offset
 * 读一片，close 释放句柄。**不再整份 readFileSync**——1GB 会把主进程内存打满。
 * 句柄空闲 60 秒自动关闭；发送期间文件 size / mtime 变化即失败（避免撕裂快照）。
 */

const fs = require('fs')
const { createHash, randomUUID } = require('crypto')
const { resolveDeliveryWorkspacePath } = require('./localWorkspaceRead.cjs')

/** 单文件上限：与 backend-ts SEND_FILE_MAX_BYTES / 渲染层 delivery-fetch 同表。 */
const DELIVERY_READ_MAX_BYTES = 1024 * 1024 * 1024
/** 单片上限：服务端固定 512KB，超出说明请求异常，直接拒绝。 */
const MAX_RANGE_BYTES = 512 * 1024
const IDLE_MS = 60_000
const SWEEP_MS = 30_000

/** openId → { fd, size, mtimeMs, lastUsedAt } */
const handles = new Map()
let sweepTimer = null

function ensureSweep() {
  if (sweepTimer != null) return
  sweepTimer = setInterval(() => {
    const now = Date.now()
    for (const [openId, entry] of [...handles]) {
      if (now - entry.lastUsedAt > IDLE_MS) closeDeliveryFile(openId)
    }
  }, SWEEP_MS)
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref()
}

function limitOf(maxBytes) {
  const requested = typeof maxBytes === 'number' && Number.isFinite(maxBytes) && maxBytes > 0
    ? Math.floor(maxBytes)
    : DELIVERY_READ_MAX_BYTES
  return Math.min(requested, DELIVERY_READ_MAX_BYTES)
}

/**
 * 打开工作区内的发送读取流。
 * @returns {{ ok: true, openId: string, size: number, mtimeMs: number } | { error: string }}
 */
function openDeliveryFile(workspace, filePath, maxBytes) {
  const resolved = resolveDeliveryWorkspacePath(workspace, filePath)
  if (resolved.error) return resolved
  const limit = limitOf(maxBytes)
  let st
  try {
    st = fs.statSync(resolved.path)
  } catch (e) {
    return { error: e.message }
  }
  if (!st.isFile()) return { error: '不是普通文件' }
  if (st.size > limit) {
    return { error: `文件过大（${Math.floor(st.size / (1024 * 1024))}MB），上限 ${Math.floor(limit / (1024 * 1024))}MB` }
  }
  let fd
  try {
    fd = fs.openSync(resolved.path, 'r')
  } catch (e) {
    return { error: e.message }
  }
  const fst = fs.fstatSync(fd)
  const openId = randomUUID()
  handles.set(openId, {
    fd,
    size: Number(fst.size),
    mtimeMs: Number(fst.mtimeMs),
    lastUsedAt: Date.now(),
  })
  ensureSweep()
  return { ok: true, openId, size: Number(fst.size), mtimeMs: Number(fst.mtimeMs) }
}

/**
 * 读取一片。每次 fstat 校验 size / mtime，变化即失败。
 * @returns {{ ok: true, bytes: Buffer, size: number, mtimeMs: number } | { error: string }}
 */
function readDeliveryChunk(openId, offset, length) {
  const entry = handles.get(openId)
  if (entry == null) return { error: '读取流已关闭或不存在' }
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
    return { error: '读取区间不合法' }
  }
  if (length > MAX_RANGE_BYTES) return { error: '读取区间超过单片上限' }
  let st
  try {
    st = fs.fstatSync(entry.fd)
  } catch (e) {
    return { error: e.message }
  }
  if (Number(st.size) !== entry.size || Number(st.mtimeMs) !== entry.mtimeMs) {
    return { error: '文件在发送期间被修改，请重试' }
  }
  entry.lastUsedAt = Date.now()
  const want = Math.min(length, Math.max(0, entry.size - offset))
  const buffer = Buffer.allocUnsafe(want)
  let filled = 0
  try {
    while (filled < want) {
      const n = fs.readSync(entry.fd, buffer, filled, want - filled, offset + filled)
      if (n <= 0) break
      filled += n
    }
  } catch (e) {
    return { error: e.message }
  }
  return { ok: true, bytes: buffer.subarray(0, filled), size: entry.size, mtimeMs: entry.mtimeMs }
}

/**
 * 整份 sha256（R8）：在已打开的句柄上顺序读取并哈希，前后各 fstat 一次；不关闭句柄。
 * @returns {Promise<{ ok: true, sha256: string, size: number, mtimeMs: number } | { error: string }>}
 */
async function digestDeliveryFile(openId) {
  const entry = handles.get(openId)
  if (entry == null) return { error: '读取流已关闭或不存在' }
  const before = fs.fstatSync(entry.fd)
  if (Number(before.size) !== entry.size || Number(before.mtimeMs) !== entry.mtimeMs) {
    return { error: '文件在发送期间被修改，请重试' }
  }
  const hash = createHash('sha256')
  const buffer = Buffer.allocUnsafe(MAX_RANGE_BYTES)
  let offset = 0
  try {
    while (offset < entry.size) {
      // 哈希期间同样算「在用」：1GB 顺序读可能超过 60 秒空闲回收窗口，被 sweep 关掉会读失败
      entry.lastUsedAt = Date.now()
      const length = Math.min(buffer.length, entry.size - offset)
      const bytesRead = await readFromFd(entry.fd, buffer, 0, length, offset)
      if (bytesRead <= 0) break
      hash.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
  } catch (e) {
    return { error: e.message }
  }
  const after = fs.fstatSync(entry.fd)
  if (Number(after.size) !== entry.size || Number(after.mtimeMs) !== entry.mtimeMs) {
    return { error: '文件在发送期间被修改，请重试' }
  }
  if (offset !== entry.size) {
    return { error: `读取中断（期望 ${entry.size} 字节，实际 ${offset}）` }
  }
  entry.lastUsedAt = Date.now()
  return { ok: true, sha256: hash.digest('hex'), size: entry.size, mtimeMs: entry.mtimeMs }
}

function readFromFd(fd, buffer, bufferOffset, length, position) {
  return new Promise((resolve, reject) => {
    fs.read(fd, buffer, bufferOffset, length, position, (err, bytesRead) => {
      if (err) reject(err)
      else resolve(bytesRead)
    })
  })
}

function closeDeliveryFile(openId) {
  const entry = handles.get(openId)
  if (entry == null) return
  handles.delete(openId)
  try {
    fs.closeSync(entry.fd)
  } catch {
    // 已关闭
  }
}

/** 进程退出 / 测试收尾：关闭全部句柄。 */
function closeAllDeliveryFiles() {
  for (const openId of [...handles.keys()]) closeDeliveryFile(openId)
  if (sweepTimer != null) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}

module.exports = {
  openDeliveryFile,
  readDeliveryChunk,
  closeDeliveryFile,
  closeAllDeliveryFiles,
  digestDeliveryFile,
  DELIVERY_READ_MAX_BYTES,
  DELIVERY_READ_RANGE_BYTES: MAX_RANGE_BYTES,
}
