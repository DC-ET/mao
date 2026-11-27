/**
 * API / WebSocket / 站点资源基址。
 *
 * 生产：跟随当前页面 origin（站点必须部署在站点根，不支持子路径）。
 * 开发 / split-domain / 子路径特殊部署：用 VITE_API_BASE_URL / VITE_WS_BASE_URL 显式覆盖。
 *
 * 同源化的目的：一份 desktop/dist 可部署到任意站点，安卓壳切换服务器后不会再把 API
 * 打到构建时烘焙的官方域名。
 */

const LOCAL_API_BASE = 'http://localhost:9080/api/v1'

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

/** 测试里 window 可能被 stub 成没有 location 的对象。 */
function currentLocation(): Location | undefined {
  if (typeof window === 'undefined') return undefined
  return window.location
}

export function apiBaseUrl(): string {
  const env = (import.meta.env.VITE_API_BASE_URL || '').trim()
  if (env) return trimSlash(env)

  const location = currentLocation()
  if (location && (location.protocol === 'http:' || location.protocol === 'https:') && location.origin) {
    return `${location.origin}/api/v1`
  }
  return LOCAL_API_BASE
}

export function wsBaseUrl(): string {
  const env = (import.meta.env.VITE_WS_BASE_URL || '').trim()
  if (env) return trimSlash(env)

  const api = apiBaseUrl()
  if (api.startsWith('/')) {
    const location = currentLocation()
    const scheme = location?.protocol === 'https:' ? 'wss' : 'ws'
    const host = location?.host || 'localhost:9080'
    return `${scheme}://${host}${api.replace(/\/api\/v1\/?$/, '/api')}`
  }
  return trimSlash(api.replace(/^http/, 'ws').replace(/\/api\/v1\/?$/, '/api'))
}

/** 站点根：用于 uploads/releases 等非 /api 资源。 */
export function siteBaseUrl(): string {
  // OTA / uploads 属于 SPA 站点，不是 API 域：split-domain 构建时 VITE_API_BASE_URL
  // 指向 API 域，清单仍必须从当前页面站点取。
  const location = currentLocation()
  if (location && (location.protocol === 'http:' || location.protocol === 'https:') && location.origin) {
    const basePath = (import.meta.env.BASE_URL || '/').replace(/\/+$/, '')
    return `${location.origin}${basePath}`
  }
  return trimSlash(apiBaseUrl().replace(/\/api\/v1\/?$/, ''))
}

/** 安卓壳 OTA 清单：跟随当前站点。 */
export function androidReleaseManifestUrl(): string {
  return `${siteBaseUrl()}/uploads/releases/android-latest.json`
}