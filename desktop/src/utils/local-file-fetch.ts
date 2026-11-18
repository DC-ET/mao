/**
 * LOCAL 正文图片按需委托读取的执行端处理（方案 2026-11-18 §5.2-2）。
 *
 * 服务端经 WS 下发 `file_fetch`（sessionId + requestId + workspace + 相对路径），
 * 这里经主进程 IPC 读工作区文件字节，按 512KB 分片、各片独立 base64 回传 `file_fetch_result`。
 * 一切失败静默不回包（对齐 agent-cli `isOutsideTrust` 口径）：防异机多执行端 error 帧竞争
 * 误杀合法分片，服务端 15s 超时自然收敛。
 *
 * 尺寸硬约束（方案 D3）：单片原始 512KB → base64 ≈683KB，序列化整帧 < 服务端 1MB maxPayload
 * （桌面出站无截断，超限帧会断整条 WS 连接）。
 */

/** 单片原始字节上限；与 backend-ts LocalFileFetchService.FILE_FETCH_CHUNK_BYTES 同表，改动须双端同步。 */
export const FILE_FETCH_CHUNK_BYTES = 512 * 1024
/** 单文件字节上限；与 backend-ts FILE_FETCH_MAX_BYTES 同表。 */
export const FILE_FETCH_MAX_BYTES = 10 * 1024 * 1024
/** 分片总数上限（10MB / 512KB）。 */
export const FILE_FETCH_MAX_CHUNKS = 20
/** 单片 base64 长度断言：单片 512KB 的 base64 为 699,052 字符，超此阈值即拒绝发送（防回归踩截断坑）。 */
export const FILE_FETCH_CHUNK_BASE64_MAX = 900_000

export interface LocalFileFetchFrame {
  requestId?: unknown
  workspace?: unknown
  path?: unknown
}

export interface LocalFileFetchDeps {
  /** 主进程委托读取（local-read-workspace-bytes）：workspace + 相对路径，containment 在主进程。 */
  readBytes: (payload: { workspace: string; path: string }) => Promise<{ bytes?: Uint8Array; size?: number; error?: string }>
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
 * 处理一帧 `file_fetch`。fire-and-forget 调用（routeEvent 是同步函数），
 * 20 片发送循环不得阻塞同连接后续帧。
 */
export async function handleLocalFileFetch(data: LocalFileFetchFrame, sessionId: number, deps: LocalFileFetchDeps): Promise<void> {
  try {
    const requestId = typeof data.requestId === 'string' ? data.requestId : ''
    const workspace = typeof data.workspace === 'string' ? data.workspace : ''
    const relativePath = typeof data.path === 'string' ? data.path : ''
    if (requestId === '' || workspace === '' || relativePath === '') return

    const result = await deps.readBytes({ workspace, path: relativePath })
    if (!result || result.error || !result.bytes || result.bytes.byteLength === 0) return
    const bytes = result.bytes instanceof Uint8Array ? result.bytes : new Uint8Array(result.bytes)
    if (bytes.byteLength > FILE_FETCH_MAX_BYTES) return
    const total = Math.ceil(bytes.byteLength / FILE_FETCH_CHUNK_BYTES)
    if (total < 1 || total > FILE_FETCH_MAX_CHUNKS) return

    for (let seq = 1; seq <= total; seq++) {
      const slice = bytes.subarray((seq - 1) * FILE_FETCH_CHUNK_BYTES, seq * FILE_FETCH_CHUNK_BYTES)
      const base64 = uint8ToBase64(slice)
      if (base64.length > FILE_FETCH_CHUNK_BASE64_MAX) return // 尺寸断言：宁缺勿超限
      const sent = await deps.send({
        type: 'file_fetch_result',
        sessionId,
        requestId,
        seq,
        total,
        data: base64,
      })
      if (!sent) return
    }
  } catch {
    // 静默：服务端 15s 超时收敛（方案 §4 / D9）
  }
}
