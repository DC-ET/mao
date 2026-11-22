'use strict'

/**
 * 浏览器直播录制开关的桌面侧取值（技术方案 2026-11-22 §3.1）。
 *
 * `settings:read` 是权限码，普通用户不能直读 admin 设置——开关值经 `GET /v1/readiness`
 * （仅登录即可读，部署级配置下发先例）随 readiness 返回，主进程缓存后向 LOCAL shell env
 * 注入 MAO_BROWSER_LIVE_RECORD=1。CLOUD 走后端 envelope 注入链，与本模块无关。
 *
 * shell 执行是高频路径：5 分钟 TTL 内复用一次 HTTP 结果；token 变化即失效；
 * 拉取失败保留上次取值（缺省关闭），并把下次重试间隔缩短到 ~30s，不给登录前的
 * 每次 shell 执行都叠加一次无谓的失败请求。
 */

const READINESS_TTL_MS = 5 * 60 * 1000
const READINESS_RETRY_MS = 30 * 1000
const REQUEST_TIMEOUT_MS = 4000

function createBrowserLiveRecordFlag({
  getApiBaseUrl,
  readAuth,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
}) {
  /** @type {{ token: string | null, value: boolean, fetchedAt: number }} */
  let cache = { token: null, value: false, fetchedAt: 0 }

  async function get() {
    const { token } = readAuth() ?? {}
    if (!token) {
      cache = { token: null, value: false, fetchedAt: 0 }
      return false
    }
    const base = getApiBaseUrl()
    if (!base) return false
    const at = now()
    if (cache.token === token && at - cache.fetchedAt < READINESS_TTL_MS) return cache.value
    try {
      const res = await fetchImpl(`${String(base).replace(/\/+$/, '')}/v1/readiness`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      const body = await res.json()
      cache = { token, value: body?.code === 0 && body?.data?.browserLiveRecordEnabled === true, fetchedAt: at }
    } catch {
      // 失败保留上次取值（缺省关）：录制是低敏管理开关，宁可少录不可误录
      cache = { token, value: cache.value, fetchedAt: at - READINESS_TTL_MS + READINESS_RETRY_MS }
    }
    return cache.value
  }

  function invalidate() {
    cache = { token: null, value: false, fetchedAt: 0 }
  }

  return { get, invalidate }
}

module.exports = { createBrowserLiveRecordFlag }
