import { ref, watch, type Ref } from 'vue'
import { api } from '../api'

/**
 * Composable to resolve model ID (number) to model name (string).
 * Provides a single source of truth for model display names.
 */
export function useModelName(modelId: Ref<number | undefined | null>) {
  const modelName = ref('')
  const loading = ref(false)
  // Ignore out-of-order responses when modelId changes quickly (e.g. enter new-task mode)
  let fetchGeneration = 0

  async function fetchModelName(id: number) {
    if (!id) {
      modelName.value = ''
      return
    }
    const generation = ++fetchGeneration
    loading.value = true
    try {
      const { data } = await api.get(`/models/${id}`)
      if (generation !== fetchGeneration) return
      modelName.value = data?.name || ''
    } catch {
      if (generation !== fetchGeneration) return
      modelName.value = ''
    } finally {
      if (generation === fetchGeneration) {
        loading.value = false
      }
    }
  }

  // Auto-fetch when modelId changes
  watch(modelId, (newId) => {
    if (newId) {
      fetchModelName(newId)
    } else {
      fetchGeneration++
      modelName.value = ''
      loading.value = false
    }
  }, { immediate: true })

  return {
    modelName,
    loading,
    fetchModelName
  }
}

/**
 * Standalone function to fetch model name by ID.
 * Use when you don't need reactive tracking.
 */
export async function getModelName(modelId: number): Promise<string> {
  if (!modelId) return ''
  try {
    const { data } = await api.get(`/models/${modelId}`)
    return data?.name || ''
  } catch {
    return ''
  }
}
