import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../api'
import { getToken } from '../utils/auth-storage'
import type { ReadinessVO } from '@mao/contracts'

/**
 * 实例就绪度与首启向导状态。TaskView 挂载时拉取一次，
 * 空状态组件复用同一份数据（不重复请求）。
 */
export const useReadinessStore = defineStore('readiness', () => {
  const loaded = ref(false)
  const loading = ref(false)
  const readiness = ref<ReadinessVO | null>(null)

  async function fetch(force = false): Promise<void> {
    if (!getToken()) return
    if (loading.value || (loaded.value && !force)) return
    loading.value = true
    try {
      const { data } = await api.get('/readiness')
      readiness.value = (data ?? null) as ReadinessVO | null
      loaded.value = true
    } catch {
      // 拉取失败保持 loaded=false：向导/降级页不出现，空状态走默认文案
    } finally {
      loading.value = false
    }
  }

  /** 向导完成 / 跳过。服务端幂等；本地同步翻转状态让覆盖层立即消失。 */
  async function completeOnboarding(input: { chosenAgentId?: number | null; skipped?: boolean }): Promise<void> {
    await api.put('/readiness/onboarding', input)
    if (readiness.value) {
      readiness.value = { ...readiness.value, onboarding: input.skipped ? 'SKIPPED' : 'DONE' }
    }
  }

  return { loaded, loading, readiness, fetch, completeOnboarding }
})
