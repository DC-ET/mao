import { ref, watch, type Ref } from 'vue'
import type { WorkspaceGitProvider } from './workspace-git-provider'
import type { GitChangedFile, GitStatusResult } from '../types/git'

export function useGitStatus(
  provider: Ref<WorkspaceGitProvider | null>,
  options?: {
    /** When true, refresh immediately and keep in sync with provider changes */
    enabled?: Ref<boolean>
  },
) {
  const loading = ref(false)
  const error = ref('')
  const status = ref<GitStatusResult | null>(null)
  const files = ref<GitChangedFile[]>([])
  let requestSeq = 0

  async function refresh() {
    const p = provider.value
    if (!p) {
      status.value = null
      files.value = []
      error.value = ''
      return
    }
    const seq = ++requestSeq
    loading.value = true
    error.value = ''
    try {
      const result = await p.getStatus()
      if (seq !== requestSeq) return
      status.value = result
      files.value = result.files || []
      if (result.error) {
        error.value = result.error
      } else if (!result.isGit) {
        error.value = ''
      }
    } catch (e: any) {
      if (seq !== requestSeq) return
      status.value = null
      files.value = []
      error.value = e?.message || '读取 Git 状态失败'
    } finally {
      if (seq === requestSeq) {
        loading.value = false
      }
    }
  }

  watch(
    [provider, () => options?.enabled?.value],
    ([p, enabled]) => {
      if (enabled === false) return
      if (!p) {
        status.value = null
        files.value = []
        error.value = ''
        return
      }
      void refresh()
    },
    { immediate: true },
  )

  return {
    loading,
    error,
    status,
    files,
    refresh,
  }
}
