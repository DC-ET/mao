import { apiBaseUrl } from './api-base'

/** 本地上传路径以 API 服务为基准；OSS 等绝对 URL 原样使用。 */
export function resolveAvatarUrl(url?: string | null): string | undefined {
  if (!url) return undefined
  if (!url.startsWith('/uploads/')) return url
  const apiBase = apiBaseUrl()
  return new URL(url, new URL(apiBase, window.location.href)).href
}
