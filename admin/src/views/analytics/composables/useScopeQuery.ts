import { ref } from 'vue'
import { api } from '../../../api'
import type { AnalyticsQuery, AnalyticsScope } from '../types'
import { periodKey } from './useAnalyticsPeriod'

interface CacheSlot<T = unknown> {
  data: T | null
  loading: boolean
  error: boolean
  loadedKey: string
}

const cache = new Map<string, CacheSlot>()
const inflight = new Map<string, Promise<unknown>>()

function slotOf(key: string): CacheSlot {
  let slot = cache.get(key)
  if (!slot) {
    slot = { data: null, loading: false, error: false, loadedKey: '' }
    cache.set(key, slot)
  }
  return slot
}

export function invalidateAnalytics(scope?: AnalyticsScope): void {
  if (!scope) {
    cache.clear()
    return
  }
  const prefix = `${scope}|`
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
}

export function useScopeQuery<T>(scope: AnalyticsScope) {
  const data = ref<T | null>(null)
  const loading = ref(false)
  const error = ref(false)
  let seq = 0

  async function fetchScope(query: AnalyticsQuery, force = false): Promise<void> {
    const key = periodKey(scope, query)
    const current = ++seq
    const slot = slotOf(key)

    if (!force && slot.data != null) {
      data.value = slot.data as T
      loading.value = false
      error.value = false
      return
    }
    if (!force && inflight.has(key)) {
      loading.value = true
      try {
        const result = await inflight.get(key)
        if (current !== seq) return
        if (result == null) {
          error.value = true
          data.value = null
        } else {
          data.value = result as T
          error.value = false
        }
      } catch {
        if (current !== seq) return
        error.value = true
      } finally {
        if (current === seq) loading.value = false
      }
      return
    }

    loading.value = true
    error.value = false
    const request = api
      .get(`/admin/analytics/${scope}`, { params: query })
      .then((res) => {
        // 拦截器已解包为 Result<T>（{ code, data }），不是 AxiosResponse
        const result = res as unknown as { code?: number; data?: T | null }
        const payload = (result?.data ?? null) as T | null
        if (payload == null) {
          throw new Error('analytics scope payload is empty')
        }
        slot.data = payload
        slot.loadedKey = key
        return payload
      })
      .finally(() => {
        inflight.delete(key)
      })
    inflight.set(key, request)
    try {
      const result = await request
      if (current !== seq) return
      data.value = result
      error.value = false
    } catch {
      if (current !== seq) return
      error.value = true
      data.value = null
    } finally {
      if (current === seq) loading.value = false
    }
  }

  function refresh(query: AnalyticsQuery): Promise<void> {
    invalidateAnalytics(scope)
    return fetchScope(query, true)
  }

  function reset(): void {
    data.value = null
    error.value = false
    loading.value = false
  }

  return { data, loading, error, fetchScope, refresh, reset }
}
