import type { SendDelivery } from '../types/chat'
import { getToken } from './auth-storage'
import { apiBaseUrl } from './api-base'

const API_BASE = apiBaseUrl()

/**
 * 发送媒体投递的稳定 key（活引用方案 2026-11-20 §5.2 评审补充；2026-11-24 send-file 补充）：
 * 形态 A 用 ref（sessionId + 路径）、send-file 用快照 id、形态 B/C 用 url。
 * 不用渲染期 resolved URL 做 key——它含渲染期 token，token 轮换会导致整列重挂载、图片重载。
 *
 * ref.type 必须分派：send-file 的 ref 没有 sessionId / path，混用会得到
 * `ref:undefined:send-file:undefined`，同一轮发的 N 个快照共用一个 key
 * （downloadingKeys 与图片网格 key 全撞）。
 */
export function deliveryKey(d: SendDelivery): string {
  if (d.ref) {
    // 穷尽分派：DeliveryRef 新增成员时这里编译失败，不会静默产出
    // `ref:undefined:<type>:undefined`（同一轮多个投递共用一个 key）
    if (d.ref.type === 'workspace') return `ref:${d.ref.sessionId}:${d.ref.type}:${d.ref.path}`
    if (d.ref.type === 'send-file') return `send-file:${d.ref.id}`
    const never: never = d.ref
    return String(never)
  }
  return d.url ?? ''
}

/**
 * 解析投递的实际取数 URL：
 * - 形态 A（workspace ref，存量消息）：实时拼 workspace-download；
 * - send-file 快照（新发送默认）：拼带属主鉴权的 send-download，只传 id 不传路径；
 * - 形态 B/C：原样返回 url。
 * token 在渲染期追加，绝不入消息 JSON，与 markdown 工作区图片同口径。
 */
export function resolveDeliveryUrl(d: SendDelivery, token: string | null): string {
  if (!d.ref) return d.url ?? ''
  // 穷尽分派：DeliveryRef 新增成员时这里编译失败，不会静默拼出
  // `sessionId=undefined&path=undefined`
  if (d.ref.type === 'workspace') {
    // 编码口径与 workspace-file-provider 的 downloadDeliveryUrl 一致（同端点两种写法后端都接受）：
    // 这里逐段 encodeURIComponent，空格得 %20；URLSearchParams 会编成 '+'，虽然后端能解，
    // 与 markdown 工作区图片的 URLSearchParams 口径分叉反而容易看混，统一取 %20。
    const params = [`sessionId=${encodeURIComponent(String(d.ref.sessionId))}`, `path=${encodeURIComponent(d.ref.path)}`]
    if (token) params.push(`token=${encodeURIComponent(token)}`)
    return `${API_BASE}/files/workspace-download?${params.join('&')}`
  }
  if (d.ref.type === 'send-file') {
    const params = [`id=${encodeURIComponent(d.ref.id)}`]
    if (token) params.push(`token=${encodeURIComponent(token)}`)
    return `${API_BASE}/files/send-download?${params.join('&')}`
  }
  const never: never = d.ref
  return String(never)
}

/** 渲染 / 点击路径的便捷入口：token 取自 auth-storage（getToken），只在调用时读取。 */
export function resolveDeliveryUrlWithToken(d: SendDelivery): string {
  return resolveDeliveryUrl(d, getToken())
}
