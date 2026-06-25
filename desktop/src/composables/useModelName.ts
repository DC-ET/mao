import { ref, watch, type Ref } from 'vue'
import { api } from '../api'

/**
 * Composable to resolve model ID (number) to model name (string).
 * Provides a single source of truth for model display names.
 */
export function useModelName(modelId: Ref<number | undefined | null>) {
  const modelName = ref('')
  const loading = ref(false)

  async function fetchModelName(id: number) {
    if (!id) {
      modelName.value = ''
      return
    }
    loading.value = true
    try {
      const { data } = await api.get(`/models/${id}`)
      modelName.value = data?.modelId || ''
    } catch {
      modelName.value = ''
    } finally {
      loading.value = false
    }
  }

  // Auto-fetch when modelId changes
  watch(modelId, (newId) => {
    if (newId) {
      fetchModelName(newId)
    } else {
      modelName.value = ''
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
    return data?.modelId || ''
  } catch {
    return ''
  }
}
