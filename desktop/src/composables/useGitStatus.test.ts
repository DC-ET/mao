import { nextTick, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { useGitStatus } from './useGitStatus'
import type { WorkspaceGitProvider } from './workspace-git-provider'
import type { GitStatusResult } from '../types/git'

/**
 * 首屏远端确认回归（2026-10-28）。
 *
 * 原缺陷：Git 管理器 Tab 首屏只发只读 getStatus，remoteStatusAvailable 恒为 false
 * 且 remoteStatusError 为空，徽标回落到默认文案「远端不可用 / 远端状态不可用」——
 * 用户什么都没做就被提示故障。修法是开启 confirmRemote 后补一次 refreshStatus
 * （内含 fetch --prune），让 ahead/behind 与徽标拿到真实远端状态。
 */
function status(overrides: Partial<GitStatusResult> = {}): GitStatusResult {
  return {
    isGit: true,
    repoRoot: '/ws/repo',
    branch: 'main',
    insertions: 0,
    deletions: 0,
    changedFileCount: 0,
    remotes: ['origin'],
    hasRemote: true,
    hasHead: true,
    detachedHead: false,
    remoteStatusAvailable: false,
    files: [],
    ...overrides,
  }
}

function fakeProvider(overrides: Partial<WorkspaceGitProvider> = {}) {
  const calls = { getStatus: 0, refreshStatus: 0 }
  const provider = {
    getRepos: vi.fn(),
    async getStatus() {
      calls.getStatus++
      return status()
    },
    async refreshStatus() {
      calls.refreshStatus++
      return status({ remoteStatusAvailable: true, remoteStatusError: undefined, aheadCount: 0, behindCount: 2 })
    },
    ...overrides,
  } as unknown as WorkspaceGitProvider
  return { provider, calls }
}

/** 等两轮 microtask + tick：本地读取与确认都是异步链。 */
async function settle() {
  await nextTick()
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

describe('useGitStatus 远端确认', () => {
  it('默认（侧边栏口径）不触发 refreshStatus', async () => {
    const { provider, calls } = fakeProvider()
    useGitStatus(ref(provider))
    await settle()
    expect(calls.getStatus).toBe(1)
    expect(calls.refreshStatus).toBe(0)
  })

  it('confirmRemote 时先出本地状态，再补一次远端确认', async () => {
    const { provider, calls } = fakeProvider()
    const s = useGitStatus(ref(provider), { confirmRemote: ref(true) })
    await settle()
    expect(calls.getStatus).toBe(1)
    expect(calls.refreshStatus).toBe(1)
    // 确认结果覆盖本地缓存：徽标与 ahead/behind 以远端为准
    expect(s.status.value?.remoteStatusAvailable).toBe(true)
    expect(s.status.value?.behindCount).toBe(2)
    expect(s.remoteLoading.value).toBe(false)
  })

  it('确认在途期间 remoteLoading 为 true，供徽标显示「确认中」', async () => {
    let release: (v: GitStatusResult) => void = () => {}
    const { provider } = fakeProvider({
      refreshStatus: vi.fn(
        () =>
          new Promise<GitStatusResult>((resolve) => {
            release = resolve
          }),
      ),
    } as unknown as Partial<WorkspaceGitProvider>)
    const s = useGitStatus(ref(provider), { confirmRemote: ref(true) })
    await settle()
    expect(s.remoteLoading.value).toBe(true)
    release(status({ remoteStatusAvailable: true }))
    await settle()
    expect(s.remoteLoading.value).toBe(false)
    expect(s.status.value?.remoteStatusAvailable).toBe(true)
  })

  it('非 git 目录不发确认请求（没有远端可 fetch）', async () => {
    const { provider, calls } = fakeProvider({
      getStatus: vi.fn(async () => {
        calls.getStatus++
        return status({ isGit: false, remoteStatusAvailable: false })
      }),
    } as unknown as Partial<WorkspaceGitProvider>)
    const s = useGitStatus(ref(provider), { confirmRemote: ref(true) })
    await settle()
    expect(calls.getStatus).toBe(1)
    expect(calls.refreshStatus).toBe(0)
    expect(s.remoteLoading.value).toBe(false)
  })

  it('远端确认失败保留本地状态，不清空变更清单', async () => {
    const { provider } = fakeProvider({
      refreshStatus: vi.fn(async () => {
        throw new Error('fetch 失败')
      }),
    } as unknown as Partial<WorkspaceGitProvider>)
    const s = useGitStatus(ref(provider), { confirmRemote: ref(true) })
    await settle()
    expect(s.error.value).toBe('')
    expect(s.status.value?.isGit).toBe(true)
    expect(s.remoteLoading.value).toBe(false)
  })

  it('provider 变化（切会话/切仓库）后迟到确认结果不写回', async () => {
    let release: (v: GitStatusResult) => void = () => {}
    const slow = {
      getRepos: vi.fn(),
      async getStatus() {
        return status()
      },
      refreshStatus: vi.fn(
        () =>
          new Promise<GitStatusResult>((resolve) => {
            release = resolve
          }),
      ),
    } as unknown as WorkspaceGitProvider
    const fast = fakeProvider().provider
    const providerRef = ref<WorkspaceGitProvider>(slow)
    const s = useGitStatus(providerRef, { confirmRemote: ref(true) })
    await settle()
    expect(s.remoteLoading.value).toBe(true)

    providerRef.value = fast
    await settle()
    // 新 provider 的确认已把 remoteLoading 接管为 true，随后正常置回
    release(status({ remoteStatusAvailable: true, behindCount: 99 }))
    await settle()
    expect(s.status.value?.remoteStatusAvailable).toBe(true)
    // 迟到结果被丢弃：behindCount 来自新仓库的确认，而不是旧仓库的 99
    expect(s.status.value?.behindCount).toBe(2)
    expect(s.remoteLoading.value).toBe(false)
  })

  it('切回非确认模式不再补确认（侧边栏与大 Tab 口径不互相污染）', async () => {
    const { provider, calls } = fakeProvider()
    const confirm = ref(true)
    const providerRef = ref<WorkspaceGitProvider>(provider)
    useGitStatus(providerRef, { confirmRemote: confirm })
    await settle()
    expect(calls.refreshStatus).toBe(1)

    confirm.value = false
    providerRef.value = provider
    await settle()
    expect(calls.refreshStatus).toBe(1)
  })
})
