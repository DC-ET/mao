import { ref, watch, type Ref } from 'vue'
import { api } from '../api'

/**
 * Composable to fetch model's max context window tokens by model ID.
 * Used to calculate context usage percentage.
 */
export function useModelContext(modelId: Ref<number | undefined | null>) {
  const maxTokens = ref<number | null>(null)
  const loading = ref(false)
  // Ignore out-of-order responses when modelId changes quickly
  let fetchGeneration = 0

  async function fetchModelContext(id: number) {
    if (!id) {
      maxTokens.value = null
      return
    }
    const generation = ++fetchGeneration
    loading.value = true
    try {
      const { data } = await api.get(`/models/${id}`)
      if (generation !== fetchGeneration) return
      maxTokens.value = data?.contextWindowTokens || null
    } catch {
      if (generation !== fetchGeneration) return
      maxTokens.value = null
    } finally {
      if (generation === fetchGeneration) {
        loading.value = false
      }
    }
  }

  // Auto-fetch when modelId changes
  watch(modelId, (newId) => {
    if (newId) {
      fetchModelContext(newId)
    } else {
      fetchGeneration++
      maxTokens.value = null
      loading.value = false
    }
  }, { immediate: true })

  return {
    maxTokens,
    loading,
    fetchModelContext
  }
}