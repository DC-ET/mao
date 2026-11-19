/**
 * LOCAL 发送字节委托读取的执行端处理（统一发送媒体方案 2026-11-18 §6.2）。
 *
 * 服务端经 WS 下发 `delivery_fetch`（requestId + workspace + path + maxBytes），
 * 这里经主进程 IPC 读工作区文件字节（相对路径或 workspace 内绝对路径，containment 在主进程），
 * 按 512KB 分片、各片独立 base64 回传 `delivery_fetch_result`。
 * 与 `local-file-fetch.ts`（正文图片，不落盘）消息名与上限都分开。
 *
 * 失败静默不回包（与 file_fetch 同口径）：未绑定会话的用户级广播下多个执行端都可能响应，
 * 错误帧会抢先毁掉合法分片，服务端 20s 超时自然收敛。
 */

/** 单片原始字节上限；与 backend-ts DELIVERY_FETCH_CHUNK_BYTES 同表，改动须双端同步。 */
export const DELIVERY_FETCH_CHUNK_BYTES = 512 * 1024
/** 单文件字节上限；与 backend-ts SEND_FILE_MAX_BYTES / 主进程 localWorkspaceRead.cjs 同表。 */
export const DELIVERY_FETCH_MAX_BYTES = 30 * 1024 * 1024
/** 分片总数上限（30MB / 512KB）。 */
export const DELIVERY_FETCH_MAX_CHUNKS = 60
/** 单片 base64 长度断言：单片 512KB 的 base64 为 699,052 字符，超此阈值即拒绝发送。 */
export const DELIVERY_FETCH_CHUNK_BASE64_MAX = 900_000

export interface DeliveryFetchFrame {
  requestId?: unknown
  workspace?: unknown
  path?: unknown
  maxBytes?: unknown
}

export interface DeliveryFetchDeps {
  /** 主进程委托读取（local-delivery-read-bytes）：workspace + 路径 + 帧内 maxBytes，containment 在主进程。 */
  readBytes: (payload: { workspace: string; path: string; maxBytes: number }) => Promise<{ bytes?: Uint8Array; size?: number; error?: string }>
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

/**
 * 处理一帧 `delivery_fetch`。fire-and-forget 调用（routeEvent 是同步函数），
 * 最多 60 片发送循环不得阻塞同连接后续帧。
 */
export async function handleDeliveryFetch(data: DeliveryFetchFrame, sessionId: number, deps: DeliveryFetchDeps): Promise<void> {
  try {
    const requestId = typeof data.requestId === 'string' ? data.requestId : ''
    const workspace = typeof data.workspace === 'string' ? data.workspace : ''
    const path = typeof data.path === 'string' ? data.path : ''
    if (requestId === '' || workspace === '' || path === '') return
    // maxBytes 取服务端发起时的副本上限（图片 20MB / 文件 30MB），执行端不再放宽
    const requestedMax = typeof data.maxBytes === 'number' && Number.isFinite(data.maxBytes) && data.maxBytes > 0
      ? Math.floor(data.maxBytes)
      : DELIVERY_FETCH_MAX_BYTES
    const maxBytes = Math.min(requestedMax, DELIVERY_FETCH_MAX_BYTES)

    const result = await deps.readBytes({ workspace, path, maxBytes })
    if (!result || result.error || !result.bytes || result.bytes.byteLength === 0) return
    const bytes = result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes)
    if (bytes.byteLength > maxBytes) return
    const total = Math.ceil(bytes.byteLength / DELIVERY_FETCH_CHUNK_BYTES)
    if (total < 1 || total > DELIVERY_FETCH_MAX_CHUNKS) return

    for (let seq = 1; seq <= total; seq++) {
      const slice = bytes.subarray((seq - 1) * DELIVERY_FETCH_CHUNK_BYTES, seq * DELIVERY_FETCH_CHUNK_BYTES)
      const base64 = uint8ToBase64(slice)
      if (base64.length > DELIVERY_FETCH_CHUNK_BASE64_MAX) return // 尺寸断言：宁缺勿超限
      const sent = await deps.send({
        type: 'delivery_fetch_result',
        sessionId,
        requestId,
        seq,
        total,
        data: base64,
      })
      if (!sent) return
    }
  } catch {
    // 静默：服务端 20s 超时收敛（§6.2）
  }
}
