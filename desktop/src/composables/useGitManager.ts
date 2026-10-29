import { ref, watch, type Ref } from 'vue'
import type { WorkspaceGitProvider } from './workspace-git-provider'
import type { GitBranchCompareResult, GitBranchInfo, GitChangedFile, GitLogEntry, GitRemoteInfo, GitStashEntry } from '../types/git'
import { isValidBranchName } from '../utils/git-manager'

/** 子导航视图：变更视图由 GitChangeList 承载（面板直接组合），其余四个由本 composable 供数。 */
export type GitManagerView = 'changes' | 'history' | 'branches' | 'stash' | 'compare'

const LOG_PAGE_SIZE = 50

/**
 * Git 管理器面板级状态机：子导航、提交历史分页（竞态序号防护）、展开提交的文件清单缓存、
 * 分支 / stash / 远端列表的懒加载与刷新。
 *
 * 懒加载口径（技术方案 §5.8）：首次切到历史 / 分支 / Stash 视图才请求，避免打开 Tab 四路全打；
 * 切走再切回不重复加载（KeepAlive 保活范围内的面板内状态）；provider 变化（切会话 / 切仓库）
 * 全部清空，由 watch 重新按需加载。
 */
export function useGitManager(provider: Ref<WorkspaceGitProvider | null>) {
  const activeView = ref<GitManagerView>('changes')

  // ===== 提交历史 =====
  const logEntries = ref<GitLogEntry[]>([])
  const logLoading = ref(false)
  const logError = ref('')
  const logOffset = ref(0)
  const logExhausted = ref(false)
  const historyLoaded = ref(false)
  const expandedCommit = ref<string | null>(null)
  const commitFiles = ref(new Map<string, GitChangedFile[]>())
  const commitFilesLoading = ref(false)
  let logSeq = 0
  let commitFilesSeq = 0

  // ===== 分支 =====
  const branches = ref<GitBranchInfo[]>([])
  const branchesLoading = ref(false)
  const branchesError = ref('')
  const branchesLoaded = ref(false)
  let branchesSeq = 0

  // ===== Stash =====
  const stashes = ref<GitStashEntry[]>([])
  const stashesLoading = ref(false)
  const stashesError = ref('')
  const stashesLoaded = ref(false)
  let stashesSeq = 0

  // ===== 远端 =====
  const remotes = ref<GitRemoteInfo[]>([])
  const remotesLoaded = ref(false)
  let remotesSeq = 0

  // ===== 分支对比 =====
  const compareBase = ref('')
  const compareTarget = ref('')
  const compareResult = ref<GitBranchCompareResult | null>(null)
  const compareLoading = ref(false)
  const compareError = ref('')
  const compareLoaded = ref(false)
  // 竞态防护：在途请求迟到不得写进新选择的结果；必须是 composable 闭包内序号（非模块级）
  let compareSeq = 0

  function resetAll() {
    logSeq++
    // commitFiles 这路同样要序号防护：在途的「提交文件清单」请求迟到会写进新仓库缓存，
    // 新旧仓库共享哈希（同远端两个 clone）时用户展开该提交命中的是旧仓库清单
    commitFilesSeq++
    logEntries.value = []
    logLoading.value = false
    logError.value = ''
    logOffset.value = 0
    logExhausted.value = false
    historyLoaded.value = false
    expandedCommit.value = null
    commitFiles.value = new Map()
    commitFilesLoading.value = false
    branchesSeq++
    branches.value = []
    branchesLoading.value = false
    branchesError.value = ''
    branchesLoaded.value = false
    stashesSeq++
    stashes.value = []
    stashesLoading.value = false
    stashesError.value = ''
    stashesLoaded.value = false
    remotesSeq++
    remotes.value = []
    remotesLoaded.value = false
    compareSeq++
    compareBase.value = ''
    compareTarget.value = ''
    compareResult.value = null
    compareLoading.value = false
    compareError.value = ''
    compareLoaded.value = false
  }

  async function loadLog(reset: boolean) {
    const p = provider.value
    if (!p) return
    const seq = ++logSeq
    logLoading.value = true
    logError.value = ''
    try {
      const entries = await p.getLog({
        limit: LOG_PAGE_SIZE,
        offset: reset ? 0 : logOffset.value,
      })
      if (seq !== logSeq) return
      logEntries.value = reset ? entries : [...logEntries.value, ...entries]
      logOffset.value = (reset ? 0 : logOffset.value) + entries.length
      logExhausted.value = entries.length < LOG_PAGE_SIZE
      historyLoaded.value = true
    } catch (e: any) {
      if (seq !== logSeq) return
      logError.value = e?.message || '读取提交历史失败'
    } finally {
      if (seq === logSeq) logLoading.value = false
    }
  }

  function loadMoreLog() {
    if (logLoading.value || logExhausted.value) return
    void loadLog(false)
  }

  function retryLog() {
    void loadLog(true)
  }

  /** 点击提交行：展开 / 收起文件清单；首次展开按 hash 拉取并缓存。 */
  async function toggleCommit(hash: string) {
    if (expandedCommit.value === hash) {
      expandedCommit.value = null
      return
    }
    expandedCommit.value = hash
    if (commitFiles.value.has(hash)) return
    const p = provider.value
    if (!p) return
    const seq = ++commitFilesSeq
    commitFilesLoading.value = true
    try {
      const result = await p.getCommitFiles(hash)
      if (seq !== commitFilesSeq) return
      const next = new Map(commitFiles.value)
      next.set(hash, result.files)
      commitFiles.value = next
    } catch (e: any) {
      if (seq !== commitFilesSeq) return
      // 拉取失败：收起展开态并让列表行可再次点击重试
      if (expandedCommit.value === hash) expandedCommit.value = null
      logError.value = e?.message || '读取提交文件清单失败'
    } finally {
      if (seq === commitFilesSeq) commitFilesLoading.value = false
    }
  }

  async function loadBranches() {
    const p = provider.value
    if (!p) return
    const seq = ++branchesSeq
    branchesLoading.value = true
    branchesError.value = ''
    try {
      const list = await p.getBranches()
      if (seq !== branchesSeq) return
      branches.value = list
      branchesLoaded.value = true
    } catch (e: any) {
      if (seq !== branchesSeq) return
      branchesError.value = e?.message || '读取分支列表失败'
    } finally {
      if (seq === branchesSeq) branchesLoading.value = false
    }
  }

  /**
   * 分支对比：两侧选满且不相同才请求（相同由 UI 拦截，这里双保险）。
   * 必须内部吞错（写进 compareError、不向外抛）——refreshLoadedViews 会挂在
   * handleRefreshAll（无 catch）的 Promise.all 链上，抛错会变成未处理 rejection 并打断刷新链。
   */
  async function loadCompare() {
    const p = provider.value
    if (!p) return
    if (!compareBase.value || !compareTarget.value || compareBase.value === compareTarget.value) return
    // 前端预检双保险（方案 §5.6）：非法分支名不发请求，文案与服务端一致；
    // 同时作废在途请求（否则迟到响应会写回已失效的选择）。
    if (!isValidBranchName(compareBase.value) || !isValidBranchName(compareTarget.value)) {
      compareSeq++
      compareResult.value = null
      compareLoaded.value = false
      compareLoading.value = false
      compareError.value = '分支不存在'
      return
    }
    const seq = ++compareSeq
    compareLoading.value = true
    compareError.value = ''
    try {
      const result = await p.compareBranches(compareBase.value, compareTarget.value)
      if (seq !== compareSeq) return
      compareResult.value = result
      compareLoaded.value = true
    } catch (e: any) {
      if (seq !== compareSeq) return
      compareError.value = e?.message || '读取分支对比失败'
    } finally {
      if (seq === compareSeq) compareLoading.value = false
    }
  }

  async function loadStashes() {
    const p = provider.value
    if (!p) return
    const seq = ++stashesSeq
    stashesLoading.value = true
    stashesError.value = ''
    try {
      const list = await p.getStashes()
      if (seq !== stashesSeq) return
      stashes.value = list
      stashesLoaded.value = true
    } catch (e: any) {
      if (seq !== stashesSeq) return
      stashesError.value = e?.message || '读取 stash 列表失败'
    } finally {
      if (seq === stashesSeq) stashesLoading.value = false
    }
  }

  /** 远端列表：状态条徽章 tooltip 用；force=true 时重复加载也会刷新。 */
  async function loadRemotes(force = false) {
    if (remotesLoaded.value && !force) return
    const p = provider.value
    if (!p) return
    const seq = ++remotesSeq
    try {
      const list = await p.getRemotes()
      if (seq !== remotesSeq) return
      remotes.value = list
      remotesLoaded.value = true
    } catch {
      if (seq !== remotesSeq) return
      // 远端列表读取失败不打扰主流程：徽章 tooltip 缺省展示远端名即可
      remotes.value = []
    }
  }

  /** 写操作后刷新已加载过的视图数据（切换分支后历史 / 分支列表都要跟着变）。 */
  async function refreshLoadedViews() {
    const tasks: Promise<void>[] = []
    if (historyLoaded.value) tasks.push(loadLog(true))
    if (branchesLoaded.value) tasks.push(loadBranches())
    if (compareLoaded.value) tasks.push(loadCompare())
    if (stashesLoaded.value) tasks.push(loadStashes())
    if (remotesLoaded.value) tasks.push(loadRemotes(true))
    await Promise.all(tasks)
  }

  /** 按当前子导航视图补一次懒加载（首次进入与 provider 变化后重载共用）。 */
  function loadActiveView() {
    if (activeView.value === 'history' && !historyLoaded.value && !logLoading.value) void loadLog(true)
    if (activeView.value === 'branches' && !branchesLoaded.value && !branchesLoading.value) void loadBranches()
    if (activeView.value === 'stash' && !stashesLoaded.value && !stashesLoading.value) void loadStashes()
    // 对比视图的分支下拉选项来自 branches：loadBranches 自身无守卫，这里必须显式判已加载 / 加载中
    if (activeView.value === 'compare' && !branchesLoaded.value && !branchesLoading.value) void loadBranches()
  }

  watch(activeView, () => {
    loadActiveView()
  })

  // 任一侧选择变化即重新对比；未选满 / 两侧相同时 loadCompare 内部直接返回（不发请求）
  watch([compareBase, compareTarget], () => {
    void loadCompare()
  })

  // provider 代表工作区 / 仓库身份：变化时丢弃全部面板数据，防新旧数据串扰；
  // 丢弃后必须按当前视图重载——否则切仓库后停在历史 / 分支 / Stash 视图会看到
  // 「尚无提交 / 暂无分支」的空态（watch(activeView) 不触发，面板不会自愈）。
  // 远端列表状态条徽标常驻可见，切仓库后一并重取（失败静默降级，不打扰主流程）
  watch(provider, () => {
    resetAll()
    loadActiveView()
    void loadRemotes(true)
  })

  return {
    activeView,
    logEntries,
    logLoading,
    logError,
    logExhausted,
    expandedCommit,
    commitFiles,
    commitFilesLoading,
    loadMoreLog,
    retryLog,
    toggleCommit,
    branches,
    branchesLoading,
    branchesError,
    loadBranches,
    compareBase,
    compareTarget,
    compareResult,
    compareLoading,
    compareError,
    loadCompare,
    stashes,
    stashesLoading,
    stashesError,
    loadStashes,
    remotes,
    loadRemotes,
    refreshLoadedViews,
  }
}
