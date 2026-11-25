/**
 * LOCAL 发送字节委托读取的执行端处理（统一发送媒体方案 2026-11-18 §6.2；
 * 2026-11-25 send_file 1GB R2 改为服务端窗口拉取）。
 *
 * 服务端按区间下发 `delivery_read`：
 * - `action = open`：校验路径 + stat，主进程持有句柄，回 `size` / `mtimeMs`；
 * - `action = read`：按 `offset` / `length` 读一片（512KB），回 base64；
 * - `action = close`：释放句柄。
 *
 * 不再「先 readFile 整份再切片」——1GB 会把渲染进程与主进程内存同时打满。
 * 错误回包带 `ok: false`：拉取模型下服务端需要区分「文件过大」「文件被修改」
 * 与「执行端版本过旧」（旧执行端不认识新帧，静默不回到 10 秒首帧超时）。
 */

/** 单片原始字节上限；与 backend-ts DELIVERY_READ_CHUNK_BYTES 同表，改动须双端同步。 */
export const DELIVERY_READ_CHUNK_BYTES = 512 * 1024
/** 单文件字节上限；与 backend-ts SEND_FILE_MAX_BYTES / 主进程 localDeliveryStream.cjs 同表。 */
export const DELIVERY_READ_MAX_BYTES = 1024 * 1024 * 1024

export interface DeliveryReadFrame {
  requestId?: unknown
  action?: unknown
  streamId?: unknown
  workspace?: unknown
  path?: unknown
  offset?: unknown
  length?: unknown
  maxBytes?: unknown
}

export interface DeliveryReadDeps {
  open: (payload: { workspace: string; path: string; maxBytes: number }) =>
    Promise<{ ok?: boolean; openId?: string; size?: number; mtimeMs?: number; error?: string }>
  read: (payload: { openId: string; offset: number; length: number }) =>
    Promise<{ ok?: boolean; bytes?: Uint8Array; size?: number; mtimeMs?: number; error?: string }>
  digest: (payload: { openId: string }) => Promise<{ ok?: boolean; sha256?: string; size?: number; mtimeMs?: number; error?: string }>
  close: (payload: { openId: string }) => Promise<{ ok?: boolean; error?: string }>
  /** WS 可靠发送；false = 连接不可写（含回传中途断线），立即放弃（服务端超时收敛）。 */
  send: (payload: Record<string, unknown>) => Promise<boolean>
}

/** Uint8Array → base64：分段 String.fromCharCode 避免参数个数超限（512KB 一段会炸栈）。 */
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

/** streamId → 主进程 openId（close 与后续 read 都按 streamId 找回句柄）。 */
const openIds = new Map<string, string>()

async function replyError(
  deps: DeliveryReadDeps,
  sessionId: number,
  requestId: string,
  error: string,
): Promise<void> {
  await deps.send({ type: 'delivery_read_result', sessionId, requestId, ok: false, error })
}

/**
 * 处理一帧 `delivery_read`。fire-and-forget 调用（routeEvent 是同步函数），
 * 单次读取不得阻塞同连接后续帧。
 */
export async function handleDeliveryRead(data: DeliveryReadFrame, sessionId: number, deps: DeliveryReadDeps): Promise<void> {
  const requestId = typeof data.requestId === 'string' ? data.requestId : ''
  const action = typeof data.action === 'string' ? data.action : ''
  const streamId = typeof data.streamId === 'string' ? data.streamId : ''
  if (requestId === '' || streamId === '') return
  try {
    if (action === 'open') {
      const workspace = typeof data.workspace === 'string' ? data.workspace : ''
      const filePath = typeof data.path === 'string' ? data.path : ''
      if (workspace === '' || filePath === '') return
      const requestedMax = typeof data.maxBytes === 'number' && Number.isFinite(data.maxBytes) && data.maxBytes > 0
        ? Math.floor(data.maxBytes)
        : DELIVERY_READ_MAX_BYTES
      const maxBytes = Math.min(requestedMax, DELIVERY_READ_MAX_BYTES)
      const opened = await deps.open({ workspace, path: filePath, maxBytes })
      if (opened == null || opened.error || opened.ok !== true || typeof opened.openId !== 'string') {
        await replyError(deps, sessionId, requestId, opened?.error || '无法打开文件')
        return
      }
      openIds.set(streamId, opened.openId)
      const sent = await deps.send({
        type: 'delivery_read_result',
        sessionId,
        requestId,
        ok: true,
        size: opened.size ?? 0,
        mtimeMs: opened.mtimeMs ?? 0,
      })
      // 回包没送出去 = 服务端不会再来 read/close，句柄当场释放，不等 60 秒空闲回收
      if (!sent) {
        openIds.delete(streamId)
        await deps.close({ openId: opened.openId }).catch(() => {})
      }
      return
    }
    if (action === 'read') {
      const openId = openIds.get(streamId)
      if (openId == null) {
        await replyError(deps, sessionId, requestId, '读取流已关闭或不存在')
        return
      }
      const offset = typeof data.offset === 'number' && Number.isFinite(data.offset) ? Math.floor(data.offset) : -1
      const length = typeof data.length === 'number' && Number.isFinite(data.length) ? Math.floor(data.length) : -1
      if (offset < 0 || length < 0 || length > DELIVERY_READ_CHUNK_BYTES) {
        await replyError(deps, sessionId, requestId, '读取区间不合法')
        return
      }
      const chunk = await deps.read({ openId, offset, length })
      if (chunk == null || chunk.error || chunk.ok !== true || !(chunk.bytes instanceof Uint8Array)) {
        await replyError(deps, sessionId, requestId, chunk?.error || '读取失败')
        return
      }
      const sent = await deps.send({
        type: 'delivery_read_result',
        sessionId,
        requestId,
        ok: true,
        data: uint8ToBase64(chunk.bytes),
        size: chunk.size ?? 0,
        mtimeMs: chunk.mtimeMs ?? 0,
      })
      if (!sent) {
        openIds.delete(streamId)
        await deps.close({ openId }).catch(() => {})
      }
      return
    }
    if (action === 'digest') {
      const openId = openIds.get(streamId)
      if (openId == null) {
        await replyError(deps, sessionId, requestId, '读取流已关闭或不存在')
        return
      }
      const digest = await deps.digest({ openId })
      if (digest == null || digest.error || digest.ok !== true || typeof digest.sha256 !== 'string') {
        await replyError(deps, sessionId, requestId, digest?.error || '文件校验失败')
        return
      }
      const sent = await deps.send({
        type: 'delivery_read_result',
        sessionId,
        requestId,
        ok: true,
        sha256: digest.sha256,
        size: digest.size ?? 0,
        mtimeMs: digest.mtimeMs ?? 0,
      })
      // 回包没送出去：服务端不会再来 close，句柄当场释放，不等 60 秒空闲回收
      if (!sent) {
        openIds.delete(streamId)
        await deps.close({ openId }).catch(() => {})
      }
      return
    }
    if (action === 'close') {
      const openId = openIds.get(streamId)
      openIds.delete(streamId)
      if (openId != null) await deps.close({ openId })
      // close 的回包服务端不等待；失败无副作用，保持静默
      return
    }
  } catch (e) {
    await replyError(deps, sessionId, requestId, e instanceof Error ? e.message : String(e))
  }
}
