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
  /**
   * 仓库身份是否已确定（当前 provider 的仓库扫描已出结果，成功 / 失败都算确定）。
   *
   * provider 变化时本 composable 会在同步阶段清空 repos 与 selectedRepoPath：
   * 这段窗口里「选中仓库」还不存在，消费者若照旧发请求就不带 repoPath，会落到工作区
   * 根目录——多仓库工作区（根目录不是 git 仓库、仓库在一级子目录）会直接被后端判成
   * 「当前工作区不是 Git 仓库」并弹错。因此消费者必须等 ready 为 true 再发请求。
   */
  const ready = ref(false)
  let requestSeq = 0

  /** 多仓库模式：工作区自身不是 git 仓库，且一级子目录存在至少一个 git 仓库。 */
  const multiRepoMode = computed(() => !isRootGit.value && repos.value.length > 0)

  /**
   * 可以按仓库发起请求：扫描已出结果，且不是「扫描失败、一个候选仓库都没拿到」的悬空态。
   *
   * 未就绪时消费者应把 provider 换成 null（= 不发请求）：这段时间没有选中仓库，
   * 照旧发请求就不带 repoPath，会落到工作区根目录——多仓库工作区根目录不是 git 仓库，
   * 后端直接报「当前工作区不是 Git 仓库」并在前端弹全局错误。
   */
  const requestReady = computed(() =>
    ready.value && !(error.value !== '' && !isRootGit.value && !selectedRepoPath.value))

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
      ready.value = false
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
        // 扫描出结果（含失败）才算仓库身份确定：失败时保留旧 repos 与旧选中项，
        // 与其配对的原 repoPath 仍然有效，消费者可以继续按旧仓库发请求。
        ready.value = true
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
    // provider 代表工作区身份。切换会话时必须同步丢弃旧仓库状态，避免新的
    // sessionId 与旧 selectedRepoPath 组合成一次越界请求。
    requestSeq++
    repos.value = []
    isRootGit.value = false
    selectedRepoPath.value = ''
    loading.value = false
    error.value = ''
    // 仓库身份失效：消费者据此暂停所有按仓库发起的请求，等这次扫描出结果
    ready.value = false
    void refresh()
  }, { immediate: true, flush: 'sync' })

  return {
    repos,
    isRootGit,
    multiRepoMode,
    ready,
    requestReady,
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
