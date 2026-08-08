import { computed, ref, watch, type Ref } from 'vue'
import type { GitRepoSummary, GitReposResult } from '../types/git'
import type { WorkspaceGitProvider } from './workspace-git-provider'

/**
 * 多仓库工作区 Git 仓库列表状态：
 * - 发现工作区一级子目录中的 git 仓库（工作区自身是 git 仓库时列表为空）；
 * - 维护当前选中的仓库（默认第一个有变更的，全部干净则第一个；不持久化）；
 * - 提供 multiRepoMode 判定（非根 git 且至少一个子仓库）。
 */
export function useGitRepos(provider: Ref<WorkspaceGitProvider | null>) {
  const repos = ref<GitRepoSummary[]>([])
  const isRootGit = ref(false)
  const loading = ref(false)
  const error = ref('')
  const selectedRepoPath = ref('')
  let requestSeq = 0

  /** 多仓库模式：工作区自身不是 git 仓库，且一级子目录存在至少一个 git 仓库。 */
  const multiRepoMode = computed(() => !isRootGit.value && repos.value.length > 0)

  /** 有变更的仓库（摘要行逐仓库展示用）。 */
  const changedRepos = computed(() => repos.value.filter(r => r.changedFileCount > 0))

  /** 统计失败/超时的仓库（保留占位，展示「不可用」而非静默消失）。 */
  const unavailableRepos = computed(() => repos.value.filter(r => r.unavailable))

  const selectedRepo = computed(() => repos.value.find(r => r.path === selectedRepoPath.value) ?? null)

  function defaultRepoPath(list: GitRepoSummary[]): string {
    if (list.length === 0) return ''
    return (list.find(r => r.changedFileCount > 0) ?? list[0]).path
  }

  async function refresh() {
    const p = provider.value
    if (!p) {
      // 使在途请求失效，防止旧会话数据迟到覆盖
      requestSeq++
      repos.value = []
      isRootGit.value = false
      selectedRepoPath.value = ''
      loading.value = false
      error.value = ''
      return
    }
    const seq = ++requestSeq
    loading.value = true
    error.value = ''
    try {
      const result: GitReposResult = await p.getRepos()
      if (seq !== requestSeq) return
      repos.value = result.repos || []
      isRootGit.value = !!result.isRootGit
      error.value = result.error || ''
      // 选中项存在性校验：仓库被删除时回退默认；首次加载按「第一个有变更」默认
      const current = selectedRepoPath.value
      if (!current || !repos.value.some(r => r.path === current)) {
        selectedRepoPath.value = defaultRepoPath(repos.value)
      }
    } catch (e: any) {
      if (seq !== requestSeq) return
      error.value = e?.message || '扫描 Git 仓库失败'
      // 保留上次成功数据：网络抖动 / 后端异常时不至于让多仓库 UI 整体消失
    } finally {
      if (seq === requestSeq) {
        loading.value = false
      }
    }
  }

  function selectRepo(path: string): boolean {
    if (repos.value.some(r => r.path === path)) {
      selectedRepoPath.value = path
      return true
    }
    return false
  }

  watch(provider, () => {
    void refresh()
  }, { immediate: true })

  return {
    repos,
    isRootGit,
    multiRepoMode,
    changedRepos,
    unavailableRepos,
    selectedRepoPath,
    selectedRepo,
    loading,
    error,
    refresh,
    selectRepo,
  }
}
