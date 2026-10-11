import { api } from '../api'

/** 上传路径始终相对于 API 服务，而不是管理后台页面。 */
export function resolveAvatarUrl(url?: string | null): string | undefined {
  if (!url) return undefined
  if (!url.startsWith('/')) return url
  return new URL(url, new URL(api.defaults.baseURL || '/api/v1', window.location.href)).href
}
