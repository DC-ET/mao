import { computed, nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useGitRepos } from './useGitRepos'
import { useGitStatus } from './useGitStatus'
import { useGitManager } from './useGitManager'
import type { WorkspaceGitProvider } from './workspace-git-provider'
import type { GitReposResult, GitStatusResult } from '../types/git'

/**
 * 多仓库工作区「仓库身份就绪」回归（2026-11-25）。
 *
 * 原缺陷：provider 变化时本 composable 在同步阶段清空仓库列表与选中仓库，但消费者
 * （Git 管理器 / 右侧检查器）仍会立刻按裸 provider 发请求——不带 repoPath，落到工作区
 * 根目录。多仓库工作区根目录不是 git 仓库，后端直接报「当前工作区不是 Git 仓库」，
 * 前端因此弹两条红色错误（关子代理 Tab、切会话回来时最容易踩中）。
 *
 * 契约：requestReady 为 false 期间消费者必须把 provider 换成 null（不发请求）；
 * 扫描出结果（含「失败但仍有旧选中项」）后才允许按仓库发请求。
 */
function fakeProvider(getRepos: () => Promise<GitReposResult>) {
  return { getRepos: vi.fn(getRepos) } as unknown as WorkspaceGitProvider
}

const reposResult = (paths: string[]): GitReposResult => ({
  isRootGit: false,
  repos: paths.map((path) => ({ name: path, path, changedFileCount: 0, insertions: 0, deletions: 0 })),
})

describe('useGitRepos 仓库身份就绪', () => {
  it('首次扫描完成前 ready/requestReady 均为 false，完成后才允许按仓库发请求', async () => {
    let release: (value: GitReposResult) => void = () => {}
    const provider = fakeProvider(() => new Promise<GitReposResult>((resolve) => { release = resolve }))
    const state = useGitRepos(ref(provider))

    expect(state.ready.value).toBe(false)
    expect(state.requestReady.value).toBe(false)
    expect(state.multiRepoMode.value).toBe(false)

    release(reposResult(['mao']))
    await nextTick(); await nextTick()
    expect(state.ready.value).toBe(true)
    expect(state.requestReady.value).toBe(true)
    expect(state.selectedRepoPath.value).toBe('mao')
  })

  it('provider 换身份后同步清空，重新扫描完成前不允许发请求', async () => {
    let release: (value: GitReposResult) => void = () => {}
    const providerRef = ref<WorkspaceGitProvider | null>(
      fakeProvider(() => new Promise<GitReposResult>((resolve) => { release = resolve })),
    )
    const state = useGitRepos(providerRef)

    release(reposResult(['mao']))
    await nextTick(); await nextTick()
    expect(state.requestReady.value).toBe(true)

    let releaseSecond: (value: GitReposResult) => void = () => {}
    providerRef.value = fakeProvider(() => new Promise<GitReposResult>((resolve) => { releaseSecond = resolve }))

    // 同步清空：此刻多仓库判定与选中仓库都为空，未就绪 → 不允许发请求
    expect(state.repos.value).toEqual([])
    expect(state.selectedRepoPath.value).toBe('')
    expect(state.requestReady.value).toBe(false)

    releaseSecond(reposResult(['mao', 'other']))
    await nextTick(); await nextTick()
    expect(state.requestReady.value).toBe(true)
    expect(state.selectedRepoPath.value).toBe('mao')
  })

  it('provider 为 null 时不可发请求', () => {
    const state = useGitRepos(ref<WorkspaceGitProvider | null>(null))
    expect(state.ready.value).toBe(false)
    expect(state.requestReady.value).toBe(false)
  })

  it('扫描失败且没有任何候选仓库时不可发请求（否则会退化成裸 provider）', async () => {
    const provider = fakeProvider(async () => ({ isRootGit: false, repos: [], error: '扫描 Git 仓库失败' }))
    const state = useGitRepos(ref(provider))
    await nextTick(); await nextTick()

    expect(state.error.value).toBe('扫描 Git 仓库失败')
    expect(state.selectedRepoPath.value).toBe('')
    expect(state.requestReady.value).toBe(false)
  })

  it('手动刷新期间沿用上次的选中仓库（不清空、不误判为未就绪）', async () => {
    let call = 0
    let releaseSecond: (value: GitReposResult) => void = () => {}
    const provider = fakeProvider(() => {
      call++
      if (call === 1) return Promise.resolve(reposResult(['mao']))
      return new Promise<GitReposResult>((resolve) => { releaseSecond = resolve })
    })
    const state = useGitRepos(ref(provider))
    await nextTick(); await nextTick()
    expect(state.selectedRepoPath.value).toBe('mao')

    void state.refresh()
    await nextTick()
    // 刷新不清空选中项：旧 repoPath 仍有效，消费者可以继续发请求
    expect(state.selectedRepoPath.value).toBe('mao')
    expect(state.requestReady.value).toBe(true)
    releaseSecond(reposResult(['mao']))
    await nextTick(); await nextTick()
    expect(state.requestReady.value).toBe(true)
  })
})

/**
 * 端到端回归：复刻 Git 管理器 Tab 的 provider 包装（含「仓库身份未就绪 → provider=null」网关），
 * 走一遍「关子代理 Tab / 切会话回来」的时序：provider 重建 + 面板激活同时发生。
 *
 * 修复前：仓库列表被同步清空后，getRemotes 与 refreshStatus 仍按裸 provider 发出（不带
 * repoPath），后端对多仓库工作区根目录报「当前工作区不是 Git 仓库」，前端弹两条红条。
 */
describe('多仓库 provider 重建（关子代理 Tab 场景）', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const okStatus = (isGit: boolean): GitStatusResult => ({
    isGit,
    insertions: 0,
    deletions: 0,
    changedFileCount: 0,
    remotes: [],
    hasRemote: false,
    hasHead: false,
    detachedHead: false,
    remoteStatusAvailable: false,
    files: [],
  })

  function makeProvider(log: string[]): WorkspaceGitProvider {
    return {
      async getRepos() {
        await sleep(20)
        return reposResult(['mao'])
      },
      async getStatus(repoPath?: string) {
        log.push(`getStatus(${repoPath ?? '-'})`)
        await sleep(10)
        return okStatus(!!repoPath)
      },
      async refreshStatus(repoPath?: string) {
        log.push(`refreshStatus(${repoPath ?? '-'})`)
        return okStatus(!!repoPath)
      },
      async getRemotes(repoPath?: string) {
        log.push(`getRemotes(${repoPath ?? '-'})`)
        return []
      },
      async getFileDiff() { return { path: '', changeType: 'MODIFIED', beforeContent: '', afterContent: '' } },
      async commit() { return { success: true, operation: 'commit' } },
      async generateCommitMessage() { return { title: '', message: '' } },
      async commitWithMessage() { return { success: true, operation: 'commit' } },
      async pull() { return { success: true, operation: 'pull' } },
      async push() { return { success: true, operation: 'push' } },
      async getLog() { return [] },
      async getCommitFiles() { return { files: [], body: '' } },
      async getCommitFileDiff() { return { path: '', changeType: 'MODIFIED', beforeContent: '', afterContent: '' } },
      async compareBranches() { return { base: '', target: '', ahead: 0, behind: 0, files: [] } },
      async compareBranchFileDiff() { return { path: '', changeType: 'MODIFIED', beforeContent: '', afterContent: '' } },
      async getBranches() { return [] },
      async getStashes() { return [] },
      async fetchRemote() { return { success: true, operation: 'fetch' } },
      async switchBranch() { return { success: true, operation: 'switch' } },
      async stashOp() { return { success: true, operation: 'stash' } },
      async discard() { return { success: true, operation: 'discard' } },
    } as unknown as WorkspaceGitProvider
  }

  it('仓库身份重置期间不发不带 repoPath 的请求，恢复后按仓库加载', async () => {
    const log: string[] = []
    const providerRef = ref<WorkspaceGitProvider | null>(makeProvider(log))
    const gitProviderRef = computed(() => providerRef.value)
    const repos = useGitRepos(gitProviderRef)
    const statusProviderRef = computed<WorkspaceGitProvider | null>(() => {
      const p = gitProviderRef.value
      if (!p || !repos.requestReady.value) return null
      if (repos.multiRepoMode.value && repos.selectedRepoPath.value) {
        const repoPath = repos.selectedRepoPath.value
        return {
          ...p,
          getStatus: () => p.getStatus(repoPath),
          refreshStatus: () => p.refreshStatus(repoPath),
          getRemotes: () => p.getRemotes(repoPath),
        }
      }
      return p
    })

    const status = useGitStatus(statusProviderRef, {
      enabled: computed(() => !!gitProviderRef.value),
      confirmRemote: computed(() => true),
    })
    useGitManager(statusProviderRef)

    await sleep(80)
    expect(status.status.value?.isGit).toBe(true)
    log.length = 0

    // provider 身份重建（workspace/executionMode/sessionId 被重新赋值）
    providerRef.value = makeProvider(log)
    // 同一时刻 Git Tab 被激活：onActivated 与 provider watcher 各发一次「读 + 确认」
    void status.refreshWithRemoteConfirmation()
    void status.refreshWithRemoteConfirmation()
    await sleep(120)

    const unscoped = log.filter((call) => call.endsWith('(-)'))
    expect(unscoped).toEqual([])
    expect(log).toContain('getStatus(mao)')
    expect(log).toContain('refreshStatus(mao)')
    expect(log).toContain('getRemotes(mao)')
  })
})