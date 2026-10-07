import { getToken } from './auth-storage'

export function apiBaseUrl(): string {
  return import.meta.env.VITE_API_BASE_URL || 'http://localhost:9080/api/v1'
}

export function sharePageUrl(token: string, isPublic: boolean): string {
  const path = isPublic ? `/share/public/${token}` : `/share/${token}`
  const hashMode = window.location.protocol === 'file:' || window.location.hash.startsWith('#/')
  if (hashMode) {
    const base = window.location.href.split('#')[0]
    return `${base}#${path}`
  }
  return `${window.location.origin}${path}`
}

export async function downloadSessionMarkdown(sessionId: string): Promise<void> {
  const token = getToken()
  const resp = await fetch(`${apiBaseUrl()}/sessions/${sessionId}/export/markdown`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  const type = resp.headers.get('content-type') || ''
  if (resp.status === 413 || type.includes('application/json')) {
    const body = await resp.json().catch(() => null) as { message?: string } | null
    const { ElMessage } = await import('element-plus')
    ElMessage.error(body?.message || (resp.status === 413 ? '导出内容过大，请改用分享链接' : '导出失败'))
    return
  }
  if (!resp.ok) {
    const { ElMessage } = await import('element-plus')
    ElMessage.error('导出失败')
    return
  }
  const blob = await resp.blob()
  const fileName = filenameFromDisposition(resp.headers.get('Content-Disposition')) || 'session.md'
  const objectUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(objectUrl)
}

function filenameFromDisposition(header: string | null): string | null {
  if (!header) return null
  const star = header.match(/filename\*=UTF-8''([^;]+)/i)
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1])
    } catch {
      return star[1]
    }
  }
  const plain = header.match(/filename="([^"]+)"/i)
  return plain?.[1] ?? null
}
