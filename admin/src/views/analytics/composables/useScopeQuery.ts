import { ref } from 'vue'
import { api } from '../../../api'
import type { AnalyticsQuery, AnalyticsScope } from '../types'
import { periodKey } from './useAnalyticsPeriod'

interface CacheSlot<T = unknown> {
  data: T | null
  loading: boolean
  error: boolean
  loadedKey: string
  /** 该份数据的实际拉取时刻，用于界面展示数据新鲜度 */
  fetchedAt: number | null
}

const cache = new Map<string, CacheSlot>()
const inflight = new Map<string, Promise<unknown>>()

/** 模块级缓存 TTL：切走再切回时超过 5 分钟的数据视为过期，强制重新拉取 */
const CACHE_TTL_MS = 5 * 60 * 1000

function isStale(slot: CacheSlot): boolean {
  return slot.fetchedAt == null || Date.now() - slot.fetchedAt > CACHE_TTL_MS
}

function slotOf(key: string): CacheSlot {
  let slot = cache.get(key)
  if (!slot) {
    slot = { data: null, loading: false, error: false, loadedKey: '', fetchedAt: null }
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
  const fetchedAt = ref<number | null>(null)
  let seq = 0

  function apply(slot: CacheSlot): void {
    data.value = slot.data as T | null
    fetchedAt.value = slot.fetchedAt
    error.value = slot.data == null
  }

  async function fetchScope(query: AnalyticsQuery, force = false): Promise<void> {
    const key = periodKey(scope, query)
    const current = ++seq
    const slot = slotOf(key)

    if (!force && slot.data != null && !isStale(slot)) {
      apply(slot)
      loading.value = false
      return
    }
    if (!force && inflight.has(key)) {
      loading.value = true
      try {
        await inflight.get(key)
        if (current !== seq) return
        apply(slot)
      } catch {
        if (current !== seq) return
        error.value = true
        data.value = null
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
        slot.fetchedAt = Date.now()
        return payload
      })
      .finally(() => {
        inflight.delete(key)
      })
    inflight.set(key, request)
    try {
      await request
      if (current !== seq) return
      apply(slot)
    } catch {
      if (current !== seq) return
      error.value = true
      data.value = null
      fetchedAt.value = null
    } finally {
      if (current === seq) loading.value = false
    }
  }

  return { data, loading, error, fetchedAt, fetchScope }
}
