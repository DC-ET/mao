import { nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useGitManager } from './useGitManager'
import type { WorkspaceGitProvider } from './workspace-git-provider'
import type { GitChangedFile, GitLogEntry } from '../types/git'

function logEntry(hash: string, title: string): GitLogEntry {
  return { hash, shortHash: hash.slice(0, 7), title, author: 'Test', date: '2026-10-28T10:00:00+08:00' }
}

function fakeProvider(overrides: Partial<WorkspaceGitProvider> = {}) {
  const calls = { getLog: 0, getCommitFiles: 0, getBranches: 0, getStashes: 0, getRemotes: 0, compareBranches: 0 }
  const provider = {
    getRepos: vi.fn(async () => ({ isRootGit: true, repos: [] })),
    getStatus: vi.fn(async () => ({ isGit: true } as never)),
    refreshStatus: vi.fn(async () => ({ isGit: true } as never)),
    getFileDiff: vi.fn(),
    commit: vi.fn(), pull: vi.fn(), push: vi.fn(),
    async getLog(opts?: { limit?: number; offset?: number }) {
      calls.getLog++
      const offset = opts?.offset ?? 0
      const limit = opts?.limit ?? 50
      const all = Array.from({ length: 7 }, (_, i) => logEntry(`hash${i}`, `commit ${i}`))
      return all.slice(offset, offset + limit)
    },
    async getCommitFiles(hash: string) {
      calls.getCommitFiles++
      return { hash, files: [{ path: `${hash}.txt`, changeType: 'MODIFIED', insertions: 1, deletions: 0 }] }
    },
    getCommitFileDiff: vi.fn(),
    async getBranches() { calls.getBranches++; return [{ name: 'main', isCurrent: true, isRemote: false }] },
    async compareBranches(base: string, target: string) {
      calls.compareBranches++
      return {
        base,
        target,
        aheadCount: 1,
        behindCount: 0,
        files: [{ path: `${target}.txt`, changeType: 'MODIFIED', insertions: 1, deletions: 0 }],
      }
    },
    async getStashes() { calls.getStashes++; return [{ ref: 'stash@{0}', message: 'wip', date: '2026-10-28T10:00:00+08:00' }] },
    async getRemotes() { calls.getRemotes++; return [{ name: 'origin', fetchUrl: 'u', pushUrl: 'u' }] },
    fetchRemote: vi.fn(), switchBranch: vi.fn(), stashOp: vi.fn(),
    ...overrides,
  } as unknown as WorkspaceGitProvider
  return { provider, calls }
}

describe('useGitManager', () => {
  it('默认停在变更视图，不预打历史/分支/stash 请求', async () => {
    const { provider, calls } = fakeProvider()
    const manager = useGitManager(ref(provider))
    await nextTick()
    expect(manager.activeView.value).toBe('changes')
    expect(calls.getLog).toBe(0)
    expect(calls.getBranches).toBe(0)
    expect(calls.getStashes).toBe(0)
  });

  it('切到历史/分支/Stash 才懒加载，切回不重复请求', async () => {
    const { provider, calls } = fakeProvider()
    const manager = useGitManager(ref(provider))

    manager.activeView.value = 'history'
    await nextTick(); await nextTick()
    expect(calls.getLog).toBe(1)
    expect(manager.logEntries.value.length).toBe(7)

    manager.activeView.value = 'branches'
    await nextTick(); await nextTick()
    expect(calls.getBranches).toBe(1)

    manager.activeView.value = 'stash'
    await nextTick(); await nextTick()
    expect(calls.getStashes).toBe(1)

    manager.activeView.value = 'history'
    manager.activeView.value = 'branches'
    manager.activeView.value = 'stash'
    await nextTick(); await nextTick()
    expect(calls.getLog).toBe(1)
    expect(calls.getBranches).toBe(1)
    expect(calls.getStashes).toBe(1)
  });

  it('加载更多累加 offset，翻完标记 exhausted', async () => {
    const { provider } = fakeProvider()
    const manager = useGitManager(ref(provider))
    manager.activeView.value = 'history'
    await nextTick(); await nextTick()
    expect(manager.logEntries.value.length).toBe(7)
    expect(manager.logExhausted.value).toBe(true)
  });

  it('分页未翻完时 loadMoreLog 追加下一页', async () => {
    const pages: GitLogEntry[][] = [
      Array.from({ length: 50 }, (_, i) => logEntry(`a${i}`, `first ${i}`)),
      Array.from({ length: 20 }, (_, i) => logEntry(`b${i}`, `second ${i}`)),
    ]
    let page = 0
    const { provider } = fakeProvider({
      getLog: vi.fn(async () => pages[page++]),
    } as unknown as Partial<WorkspaceGitProvider>)
    const manager = useGitManager(ref(provider))
    manager.activeView.value = 'history'
    await nextTick(); await nextTick()
    expect(manager.logEntries.value.length).toBe(50)
    expect(manager.logExhausted.value).toBe(false)

    manager.loadMoreLog()
    await nextTick(); await nextTick()
    expect(manager.logEntries.value.length).toBe(70)
    expect(manager.logExhausted.value).toBe(true)
  });

  it('历史加载失败给出错误态，重试重新拉取', async () => {
    let fail = true
    const { provider } = fakeProvider({
      getLog: vi.fn(async () => {
        if (fail) throw new Error('boom')
        return [logEntry('hash0', 'commit 0')]
      }),
    } as unknown as Partial<WorkspaceGitProvider>)
    const manager = useGitManager(ref(provider))
    manager.activeView.value = 'history'
    await nextTick(); await nextTick()
    expect(manager.logError.value).toBe('boom')
    expect(manager.logEntries.value.length).toBe(0)

    fail = false
    manager.retryLog()
    await nextTick(); await nextTick()
    expect(manager.logError.value).toBe('')
    expect(manager.logEntries.value.length).toBe(1)
  });

  it('展开提交按 hash 拉取文件清单并缓存，再次展开不重复请求', async () => {
    const { provider, calls } = fakeProvider()
    const manager = useGitManager(ref(provider))
    manager.activeView.value = 'history'
    await nextTick(); await nextTick()

    await manager.toggleCommit('hash0')
    expect(manager.expandedCommit.value).toBe('hash0')
    expect(calls.getCommitFiles).toBe(1)
    expect(manager.commitFiles.value.get('hash0')?.length).toBe(1)

    // 收起再展开：命中缓存
    await manager.toggleCommit('hash0')
    expect(manager.expandedCommit.value).toBeNull()
    await manager.toggleCommit('hash0')
    expect(calls.getCommitFiles).toBe(1)
  });

  it('展开提交拉取失败时收起展开态，可再次点击重试', async () => {
    let fail = true
    const { provider } = fakeProvider({
      getCommitFiles: vi.fn(async () => {
        if (fail) throw new Error('no such commit')
        return { hash: 'hash0', files: [] }
      }),
    } as unknown as Partial<WorkspaceGitProvider>)
    const manager = useGitManager(ref(provider))
    await manager.toggleCommit('hash0')
    expect(manager.expandedCommit.value).toBeNull()
    expect(manager.logError.value).toBe('no such commit')

    fail = false
    await manager.toggleCommit('hash0')
    expect(manager.expandedCommit.value).toBe('hash0')
    expect(manager.commitFiles.value.has('hash0')).toBe(true)
  });

  it('远端列表读取失败不冒泡错误，徽章 tooltip 缺省降级', async () => {
    const { provider } = fakeProvider({
      getRemotes: vi.fn(async () => { throw new Error('offline') }),
    } as unknown as Partial<WorkspaceGitProvider>)
    const manager = useGitManager(ref(provider))
    await manager.loadRemotes()
    expect(manager.remotes.value).toEqual([])
  });

  it('远端列表已加载后重复调用不请求，force 才刷新', async () => {
    const { provider, calls } = fakeProvider()
    const manager = useGitManager(ref(provider))
    await manager.loadRemotes()
    await manager.loadRemotes()
    expect(calls.getRemotes).toBe(1)
    await manager.loadRemotes(true)
    expect(calls.getRemotes).toBe(2)
  });

  it('refreshLoadedViews 只重载已加载过的视图', async () => {
    const { provider, calls } = fakeProvider()
    const manager = useGitManager(ref(provider))
    manager.activeView.value = 'branches'
    await nextTick(); await nextTick()
    expect(calls.getBranches).toBe(1)

    await manager.refreshLoadedViews()
    expect(calls.getBranches).toBe(2)
    // 历史 / stash 从未加载过，不随之多打请求
    expect(calls.getLog).toBe(0)
    expect(calls.getStashes).toBe(0)
  });

  it('provider 变化（切会话 / 切仓库）时全部状态清空', async () => {
    const first = fakeProvider()
    const providerRef = ref<WorkspaceGitProvider | null>(first.provider)
    const manager = useGitManager(providerRef)
    manager.activeView.value = 'history'
    await nextTick(); await nextTick()
    expect(manager.logEntries.value.length).toBe(7)

    const second = fakeProvider()
    providerRef.value = second.provider
    await nextTick(); await nextTick()
    // 展开态与文件清单缓存随旧仓库数据一起丢弃
    expect(manager.expandedCommit.value).toBeNull()
    expect(manager.commitFiles.value.size).toBe(0)
    // 当前在历史视图：reset 后立即用新 provider 重载（见下一条用例）
    expect(second.calls.getLog).toBe(1)
  });

  it('provider 变化后按当前视图自动重载，不再显示误导性空态', async () => {
    // 切仓库后停留在历史 / 分支 / Stash 视图：resetAll 会清空数据，但 watch(activeView)
    // 不触发，若不补偿重载，用户看到的是「尚无提交 / 暂无分支」的错误空态
    for (const view of ['history', 'branches', 'stash'] as const) {
      const first = fakeProvider()
      const providerRef = ref<WorkspaceGitProvider | null>(first.provider)
      const manager = useGitManager(providerRef)
      manager.activeView.value = view
      await nextTick(); await nextTick()
      expect(manager.activeView.value).toBe(view)

      const second = fakeProvider()
      providerRef.value = second.provider
      await nextTick(); await nextTick()

      if (view === 'history') {
        expect(second.calls.getLog).toBe(1)
        expect(manager.logEntries.value.length).toBe(7)
      } else if (view === 'branches') {
        expect(second.calls.getBranches).toBe(1)
        expect(manager.branches.value.length).toBe(1)
      } else {
        expect(second.calls.getStashes).toBe(1)
        expect(manager.stashes.value.length).toBe(1)
      }
      // 远端列表状态条徽标常驻：切仓库后一并重取
      expect(second.calls.getRemotes).toBe(1)
    }
  });

  it('provider 变化后停在变更视图时不预打历史/分支/stash 请求', async () => {
    const first = fakeProvider()
    const providerRef = ref<WorkspaceGitProvider | null>(first.provider)
    useGitManager(providerRef)
    await nextTick(); await nextTick()
    const second = fakeProvider()
    providerRef.value = second.provider
    await nextTick(); await nextTick()
    expect(second.calls.getLog).toBe(0)
    expect(second.calls.getBranches).toBe(0)
    expect(second.calls.getStashes).toBe(0)
    expect(second.calls.getRemotes).toBe(1)
  });

  it('切仓库后在途的提交文件清单迟到被丢弃，不污染新仓库缓存', async () => {
    // 新旧仓库共享提交哈希（同远端两个 clone）时，迟到的旧仓库清单会写进新仓库缓存
    let releaseStale: (() => void) | null = null
    const stale = new Promise<{ hash: string; files: GitChangedFile[] }>((resolve) => {
      releaseStale = () => resolve({ hash: 'shared-hash', files: [{ path: 'old.txt', changeType: 'MODIFIED', insertions: 9, deletions: 9 }] })
    })
    const first = fakeProvider({
      getCommitFiles: vi.fn(async () => stale),
    } as unknown as Partial<WorkspaceGitProvider>)
    const providerRef = ref<WorkspaceGitProvider | null>(first.provider)
    const manager = useGitManager(providerRef)
    manager.activeView.value = 'history'
    await nextTick(); await nextTick()
    // 在途：展开旧仓库 shared-hash 的文件清单
    void manager.toggleCommit('shared-hash')

    const second = fakeProvider()
    providerRef.value = second.provider
    await nextTick(); await nextTick()
    releaseStale!()
    await nextTick(); await nextTick()

    // 迟到的旧仓库结果必须被丢弃，缓存不留旧仓库数据
    expect(manager.commitFiles.value.size).toBe(0)
    // 新仓库展开同一 hash 时才真正请求
    await manager.toggleCommit('shared-hash')
    expect(second.calls.getCommitFiles).toBe(1)
    expect(manager.commitFiles.value.get('shared-hash')?.[0].path).toBe('shared-hash.txt')
  });

  it('provider 为 null 时不发请求', async () => {
    const { calls } = fakeProvider()
    const manager = useGitManager(ref<WorkspaceGitProvider | null>(null))
    manager.activeView.value = 'history'
    await nextTick(); await nextTick()
    expect(calls.getLog).toBe(0)
    expect(manager.logEntries.value).toEqual([])
  });

  it('慢响应迟到被竞态序号丢弃，不覆盖新列表', async () => {
    let releaseSlow: (() => void) | null = null
    const slow = new Promise<GitLogEntry[]>((resolve) => { releaseSlow = () => resolve([logEntry('slow', 'slow')]) })
    let fastCalls = 0
    const { provider } = fakeProvider({
      getLog: vi.fn(async () => {
        fastCalls++
        return fastCalls === 1 ? slow : [logEntry('fast', 'fast')]
      }),
    } as unknown as Partial<WorkspaceGitProvider>)
    const manager = useGitManager(ref(provider))
    manager.activeView.value = 'history'
    await nextTick(); await nextTick()

    // 第一次请求在途时重试：旧请求后完成，其结果必须被丢弃
    manager.retryLog()
    await nextTick(); await nextTick()
    expect(manager.logEntries.value.map((e) => e.title)).toEqual(['fast'])

    releaseSlow!()
    await nextTick(); await nextTick()
    expect(manager.logEntries.value.map((e) => e.title)).toEqual(['fast'])
  });
});

describe('useGitManager 分支对比', () => {
  it('两侧选满且不相同才请求；相同 / 缺一 / 未选不请求', async () => {
    const { provider, calls } = fakeProvider()
    const manager = useGitManager(ref(provider))

    manager.compareBase.value = 'main'
    await nextTick(); await nextTick()
    expect(calls.compareBranches).toBe(0)

    // 两侧相同：UI 拦截，composable 双保险不发请求
    manager.compareTarget.value = 'main'
    await nextTick(); await nextTick()
    expect(calls.compareBranches).toBe(0)

    manager.compareTarget.value = 'feature'
    await nextTick(); await nextTick()
    expect(calls.compareBranches).toBe(1)
    expect(manager.compareResult.value?.target).toBe('feature')

    // 任一侧变更即重新对比
    manager.compareBase.value = 'origin/main'
    await nextTick(); await nextTick()
    expect(calls.compareBranches).toBe(2)
  });

  it('切到对比视图懒加载分支列表，且有守卫不重复请求', async () => {
    const { provider, calls } = fakeProvider()
    const manager = useGitManager(ref(provider))

    manager.activeView.value = 'compare'
    await nextTick(); await nextTick()
    expect(calls.getBranches).toBe(1)

    manager.activeView.value = 'branches'
    manager.activeView.value = 'compare'
    await nextTick(); await nextTick()
    expect(calls.getBranches).toBe(1)
  });

  it('分支行预填：只写目标槽时不自动请求，补选基准才请求', async () => {
    const { provider, calls } = fakeProvider()
    const manager = useGitManager(ref(provider))

    manager.compareTarget.value = 'feature'
    manager.activeView.value = 'compare'
    await nextTick(); await nextTick()
    expect(calls.compareBranches).toBe(0)
    expect(manager.compareBase.value).toBe('')

    manager.compareBase.value = 'main'
    await nextTick(); await nextTick()
    expect(calls.compareBranches).toBe(1)
  });

  it('已加载过对比后 refreshLoadedViews 触发重算；未加载过不请求', async () => {
    const { provider, calls } = fakeProvider()
    const manager = useGitManager(ref(provider))

    await manager.refreshLoadedViews()
    expect(calls.compareBranches).toBe(0)

    manager.compareBase.value = 'a'
    manager.compareTarget.value = 'b'
    await nextTick(); await nextTick()
    expect(calls.compareBranches).toBe(1)

    await manager.refreshLoadedViews()
    expect(calls.compareBranches).toBe(2)
  });

  it('对比失败写入 compareError 且刷新链不 reject（loadCompare 内部吞错）', async () => {
    let fail = false
    const { provider } = fakeProvider({
      compareBranches: vi.fn(async (base: string, target: string) => {
        if (fail) throw new Error('对比失败，请重试')
        return { base, target, aheadCount: 0, behindCount: 0, files: [] }
      }),
    } as unknown as Partial<WorkspaceGitProvider>)
    const manager = useGitManager(ref(provider))
    manager.compareBase.value = 'a'
    manager.compareTarget.value = 'b'
    await nextTick(); await nextTick()
    expect(manager.compareError.value).toBe('')
    expect(manager.compareResult.value).not.toBeNull()

    fail = true
    await expect(manager.refreshLoadedViews()).resolves.toBeUndefined()
    expect(manager.compareError.value).toBe('对比失败，请重试')
  });

  it('provider 变化（切仓库 / 切会话）清空对比选择与结果', async () => {
    const first = fakeProvider()
    const providerRef = ref<WorkspaceGitProvider | null>(first.provider)
    const manager = useGitManager(providerRef)
    manager.compareBase.value = 'a'
    manager.compareTarget.value = 'b'
    await nextTick(); await nextTick()
    expect(manager.compareResult.value).not.toBeNull()

    const second = fakeProvider()
    providerRef.value = second.provider
    await nextTick(); await nextTick()
    expect(manager.compareBase.value).toBe('')
    expect(manager.compareTarget.value).toBe('')
    expect(manager.compareResult.value).toBeNull()
    expect(second.calls.compareBranches).toBe(0)
  });

  it('在途对比响应迟到被竞态序号丢弃，不覆盖新选择的结果', async () => {
    let releaseSlow: ((value: any) => void) | null = null
    const slow = new Promise((resolve) => { releaseSlow = resolve as (value: any) => void })
    let calls = 0
    const { provider } = fakeProvider({
      compareBranches: vi.fn(async (base: string, target: string) => {
        calls++
        if (calls === 1) return slow as any
        return { base, target, aheadCount: 0, behindCount: 0, files: [{ path: 'new.txt', changeType: 'MODIFIED', insertions: 0, deletions: 0 }] }
      }),
    } as unknown as Partial<WorkspaceGitProvider>)
    const manager = useGitManager(ref(provider))

    manager.compareBase.value = 'a'
    manager.compareTarget.value = 'b'
    await nextTick(); await nextTick()
    // 在途时换目标分支：旧响应迟到不得写入新选择的结果
    manager.compareTarget.value = 'c'
    await nextTick(); await nextTick()
    releaseSlow!({ base: 'a', target: 'b', aheadCount: 9, behindCount: 9, files: [{ path: 'old.txt', changeType: 'MODIFIED', insertions: 9, deletions: 9 }] })
    await nextTick(); await nextTick()
    expect(manager.compareResult.value?.files[0]?.path).toBe('new.txt')
  });

  it('非法分支名不发请求：前端预检拦截并提示分支不存在', async () => {
    const { provider, calls } = fakeProvider()
    const manager = useGitManager(ref(provider))

    manager.compareBase.value = '-x'
    manager.compareTarget.value = 'feature'
    await nextTick(); await nextTick()
    expect(calls.compareBranches).toBe(0)
    expect(manager.compareError.value).toBe('分支不存在')
    expect(manager.compareResult.value).toBeNull()

    // 换成合法分支后恢复正常请求，并清掉预检错误
    manager.compareBase.value = 'main'
    await nextTick(); await nextTick()
    expect(calls.compareBranches).toBe(1)
    expect(manager.compareError.value).toBe('')
  });
});
