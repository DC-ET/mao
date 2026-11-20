import type { SendDelivery } from '../types/chat'
import { getToken } from './auth-storage'

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:9080/api/v1'

/**
 * 发送媒体投递的稳定 key（活引用方案 2026-11-20 §5.2 评审补充）：
 * 形态 A 用 ref（sessionId + 路径）、形态 B/C 用 url。不用渲染期 resolved URL 做 key——
 * 它含渲染期 token，token 轮换会导致整列重挂载、图片重载。
 */
export function deliveryKey(d: SendDelivery): string {
  if (d.ref) return `ref:${d.ref.sessionId}:${d.ref.type}:${d.ref.path}`
  return d.url ?? ''
}

/**
 * 解析投递的实际取数 URL：形态 A（ref）实时拼 workspace-download（渲染期追加 token，
 * token 绝不入消息 JSON，与 markdown 工作区图片同口径）；形态 B/C 原样返回 url。
 */
export function resolveDeliveryUrl(d: SendDelivery, token: string | null): string {
  if (!d.ref) return d.url ?? ''
  // 编码口径与 workspace-file-provider 的 downloadDeliveryUrl 一致（同端点两种写法后端都接受）：
  // 这里逐段 encodeURIComponent，空格得 %20；URLSearchParams 会编成 '+'，虽然后端能解，
  // 与 markdown 工作区图片的 URLSearchParams 口径分叉反而容易看混，统一取 %20。
  const params = [`sessionId=${encodeURIComponent(String(d.ref.sessionId))}`, `path=${encodeURIComponent(d.ref.path)}`]
  if (token) params.push(`token=${encodeURIComponent(token)}`)
  return `${API_BASE}/files/workspace-download?${params.join('&')}`
}

/** 渲染 / 点击路径的便捷入口：token 取自 auth-storage（getToken），只在调用时读取。 */
export function resolveDeliveryUrlWithToken(d: SendDelivery): string {
  return resolveDeliveryUrl(d, getToken())
}
