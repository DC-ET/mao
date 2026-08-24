import type { Router } from 'vue-router'

/** 站内保留前缀：这些前缀不属于桌面 SPA 路由（生产单域名下归 admin / API / 上传）。 */
const RESERVED_PREFIXES = ['/admin', '/api', '/uploads']
const FORBIDDEN_PROTOCOLS = ['http:', 'https:', 'javascript:']

/**
 * 校验登录后回跳地址：仅接受站内路径。
 * 空、非法、指向 /login 自身或保留前缀时回退到 '/'。
 * Hash 模式下 to.fullPath 已是应用路径（如 /tasks/1?x=1），可直接作为 redirect 使用。
 */
export function safeRedirect(raw: unknown): string {
  if (typeof raw !== 'string') return '/'
  let value = raw.trim()
  if (!value) return '/'
  try {
    // 剥掉可能的编码形式，统一按路径判断
    value = decodeURIComponent(value)
  } catch {
    // 解码失败按原样处理
  }
  if (!value.startsWith('/') || value.startsWith('//')) return '/'
  if (FORBIDDEN_PROTOCOLS.some(p => value.toLowerCase().startsWith(p))) return '/'
  if (RESERVED_PREFIXES.some(p => value === p || value.startsWith(`${p}/`))) return '/'
  if (value === '/login' || value.startsWith('/login?') || value.startsWith('/login/')) return '/'
  return value
}

export function readRedirectQuery(query: unknown): string {
  if (query && typeof query === 'object' && 'redirect' in query) {
    return safeRedirect((query as { redirect: unknown }).redirect)
  }
  return '/'
}

/**
 * 未登录跳转登录页。必须用 vue-router（Hash 模式下写死 window.location.href 会打错地址），
 * 模块级防抖避免并发 401 触发多次 replace。
 */
let isRedirectingToLogin = false

export function redirectToLogin(router: Router, redirectPath?: string): void {
  const current = router.currentRoute.value
  const target = safeRedirect(redirectPath ?? current.fullPath)
  if (current.name === 'Login') return
  if (isRedirectingToLogin) return
  isRedirectingToLogin = true
  router
    .replace({
      name: 'Login',
      query: target && target !== '/' ? { redirect: target } : {}
    })
    .finally(() => {
      isRedirectingToLogin = false
    })
}
