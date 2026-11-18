import { searchLocalWorkspace } from '../composables/workspace-file-provider'
import { isElectronClient } from './platform'
import { resolveWithinWorkspace } from './workspace-path'

/**
 * LOCAL 会话文件树远程代理的设备端执行器（技术方案 2026-11-17 §4.2）。
 * 服务端把 file_op_request 定向投给执行端设备的 Electron renderer 连接；这里按 op 调
 * 既有 preload 文件原语执行并组装 file_op_result 回帧。read / bytes 类 IPC handler 自身
 * 无 workspace containment 校验（仅 list-directory 有），因此统一在本层前置校验（防 .. 逃逸）。
 * 回帧尺寸预检按最终整帧 UTF-8 字节（D8）：WS 入站 maxPayload 1MB，超限会断连——
 * 宁可回友好错误，不可超限（不能用字符串 length：那是 UTF-16 数，中文 3 字节/字符会系统性低估）。
 */

export type LocalFileOp = 'list' | 'read' | 'search' | 'files'

export interface LocalFileOpRequest {
  requestId: string
  op: LocalFileOp
  params: Record<string, unknown>
  workspace: string
}

export interface LocalFileOpResultFrame {
  type: 'file_op_result'
  sessionId: number
  requestId: string
  ok: boolean
  data?: unknown
  error?: string
}

/** 回帧字节上限（D8）：maxPayload 1MB 减信封与转义余量。 */
export const FILE_OP_MAX_FRAME_BYTES = 700 * 1024

const OP_NOT_SUPPORTED = '当前客户端不支持执行文件操作'

function frameBytes(frame: LocalFileOpResultFrame): number {
  return new TextEncoder().encode(JSON.stringify(frame)).length
}

/** 与 main.cjs list-directory 的 containment 口径一致：workspace 内或 workspace 本身。 */
function resolveContainedPath(workspace: string, relativePath: unknown): string | null {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return null
  return resolveWithinWorkspace(workspace, relativePath)
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

async function runOp(request: LocalFileOpRequest): Promise<unknown> {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined
  if (!isElectronClient() || !api) {
    throw new Error(OP_NOT_SUPPORTED)
  }
  const { op, params, workspace } = request
  if (!workspace || typeof workspace !== 'string') {
    throw new Error('缺少工作区路径')
  }
  switch (op) {
    case 'list': {
      const abs = resolveContainedPath(workspace, params.dir !== undefined ? params.dir : '.')
      if (abs == null) throw new Error('路径越出工作区范围')
      return await api.listDirectory(abs, workspace)
    }
    case 'read': {
      const abs = resolveContainedPath(workspace, params.path)
      if (abs == null) throw new Error('路径越出工作区范围')
      return await api.localReadFile({
        path: abs,
        offset: typeof params.offset === 'number' ? params.offset : 0,
        limit: typeof params.limit === 'number' ? params.limit : 5000,
      })
    }
    case 'search': {
      if (typeof params.pattern !== 'string' || params.pattern.trim().length === 0) {
        throw new Error('缺少搜索关键词')
      }
      return await searchLocalWorkspace(workspace, params.pattern, typeof params.limit === 'number' ? params.limit : 100)
    }
    case 'files': {
      return await api.listWorkspaceFiles(workspace, asOptionalString(params.filter), typeof params.limit === 'number' ? params.limit : 20)
    }
    default:
      throw new Error(`不支持的文件操作类型: ${String(op)}`)
  }
}

/**
 * 执行一次文件代理请求并组装回帧。永不抛错：任何失败（不支持 / 越界 / IPC 报错 /
 * 结果超尺寸）都收敛为 ok=false 的中文错误帧，由服务端透传给发起端展示。
 * 设备端 IPC 结果带 error 字段（如「Access denied: path outside workspace」）时同样收敛为失败帧。
 */
export async function executeLocalFileOp(sessionId: number, request: LocalFileOpRequest): Promise<LocalFileOpResultFrame> {
  const base = { type: 'file_op_result' as const, sessionId, requestId: request.requestId }
  try {
    let data: unknown
    try {
      data = await runOp(request)
    } catch (e) {
      return { ...base, ok: false, error: e instanceof Error ? e.message : '文件操作执行失败' }
    }
    // 设备端原语失败不抛错而是返回 { error }（如 list-directory 的越界 / 不存在文案）：转为失败帧
    if (data != null && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string') {
      return { ...base, ok: false, error: (data as { error: string }).error }
    }
    const frame: LocalFileOpResultFrame = { ...base, ok: true, data }
    if (frameBytes(frame) > FILE_OP_MAX_FRAME_BYTES) {
      return { ...base, ok: false, error: '文件过大，移动端暂不支持查看该文件' }
    }
    return frame
  } catch (e) {
    return { ...base, ok: false, error: e instanceof Error ? e.message : '文件操作执行失败' }
  }
}
