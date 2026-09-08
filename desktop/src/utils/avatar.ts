/** 本地上传路径以 API 服务为基准；OSS 等绝对 URL 原样使用。 */
export function resolveAvatarUrl(url?: string | null): string | undefined {
  if (!url) return undefined
  if (!url.startsWith('/uploads/')) return url
  const apiBase = import.meta.env.VITE_API_BASE_URL || 'http://localhost:9080/api/v1'
  return new URL(url, new URL(apiBase, window.location.href)).href
}
