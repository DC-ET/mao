import { ref, watch, type Ref } from 'vue'
import type { WorkspaceGitProvider } from './workspace-git-provider'
import type { GitChangedFile, GitStatusResult } from '../types/git'

export function useGitStatus(
  provider: Ref<WorkspaceGitProvider | null>,
  options?: {
    /** When true, refresh immediately and keep in sync with provider changes */
    enabled?: Ref<boolean>
    /**
     * When true, the local status is followed by one remote confirmation
     * (`refreshStatus`, which runs `fetch --prune`) so ahead/behind and the remote
     * badge reflect the server instead of the cached refs.
     */
    confirmRemote?: Ref<boolean>
  },
) {
  const loading = ref(false)
  const error = ref('')
  const status = ref<GitStatusResult | null>(null)
  const files = ref<GitChangedFile[]>([])
  /** 远端确认（fetch）进行中：徽标显示「确认中」，避免把未确认态误报成不可用。 */
  const remoteLoading = ref(false)
  /** provider 变化的侦听序号：确认在途时切换会话/仓库即作废，结果不再写回。 */
  let confirmSeq = 0
  let requestSeq = 0

  async function load(remote: boolean): Promise<boolean> {
    const p = provider.value
    if (!p) {
      requestSeq++
      confirmSeq++
      status.value = null
      files.value = []
      error.value = ''
      remoteLoading.value = false
      return false
    }    const seq = ++requestSeq
    // 新读取接管远端确认态：在途的确认结果会被 confirmSeq 判负丢弃，
    // 若不在这里清零，徽标会永远停在「确认中」。
    remoteLoading.value = false
    confirmSeq++
    loading.value = true
    error.value = ''
    try {
      const result = remote ? await p.refreshStatus() : await p.getStatus()
      if (seq !== requestSeq) return false
      status.value = result
      files.value = result.files || []
      if (result.error) {
        error.value = result.error
      } else if (!result.isGit) {
        error.value = ''
      }
      // 只有本次结果真的落到 status 上才算读取生效；被后发请求作废时返回 false，
      // 调用方不能再拿旧 status 继续做事（远端确认会因此打到错误仓库）。
      return true
    } catch (e: any) {
      if (seq !== requestSeq) return false
      status.value = null
      files.value = []
      error.value = e?.message || '读取 Git 状态失败'
      return false
    } finally {
      if (seq === requestSeq) {
        loading.value = false
      }
    }
  }

  const refresh = () => load(false)
  const refreshRemote = () => load(true)

  /**
   * 打开 Tab / 切会话 / 切仓库时的首屏读取：本地状态先出（变更清单立即可见），
   * 成功后补一次远端确认。非 git 目录直接跳过确认——没有远端可 fetch。
   * 确认结果迟到时按序号丢弃：provider 已切换则新仓库有自己的确认请求。
   *
   * 确认必须绑定「刚刚读到这份 status 的那次读取」：读取被后发请求作废（序号变了，
   * status 仍是上一次仓库的旧值）或 provider 身份已换（多仓库包装层会随仓库列表重建）
   * 时一律放弃确认。否则会拿「旧仓库 isGit=true」去对新 provider 发 refresh，
   * 多仓库工作区里正好落到根目录 → 后端报「当前工作区不是 Git 仓库」。
   */
  async function loadWithRemoteConfirmation() {
    const providerBefore = provider.value
    const applied = await refresh()
    const p = provider.value
    if (!applied || !p || p !== providerBefore) return
    if (options?.confirmRemote?.value !== true) return
    const current = status.value
    if (!current?.isGit) return
    const seq = ++confirmSeq
    remoteLoading.value = true
    try {
      const result = await p.refreshStatus()
      if (seq !== confirmSeq) return
      status.value = result
      files.value = result.files || []
    } catch {
      // 远端确认失败保留本地状态：ahead/behind 与徽标沿用缓存口径，fetch 失败原因
      // 由后端 status.remoteStatusError 承载（refreshStatus 自身不抛业务异常）。
    } finally {
      if (seq === confirmSeq) remoteLoading.value = false
    }
  }

  watch(
    [provider, () => options?.enabled?.value],
    ([p, enabled]) => {
      if (enabled === false) return
      if (!p) {
        requestSeq++
        confirmSeq++
        status.value = null
        files.value = []
        error.value = ''
        remoteLoading.value = false
        return
      }
      if (options?.confirmRemote?.value === true) {
        void loadWithRemoteConfirmation()
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
    remoteLoading,
    refresh,
    refreshRemote,
    refreshWithRemoteConfirmation: loadWithRemoteConfirmation,
  }
}
