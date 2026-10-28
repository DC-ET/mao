// 两步提交（中央 Tab）在 useGitOperations 里的分发与 toast 口径：
// commit-with-message 必须透传 message/repoPath 到 provider.commitWithMessage，
// 成功 toast 与一步提交同款（含短哈希与标题），失败只 toast 不抛错，且沿用全局防重入。
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('element-plus', () => ({
  ElMessage: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

import { ElMessage } from 'element-plus'
import { ref } from 'vue'
import { useGitOperations } from './useGitOperations'

function stubProvider(overrides: Record<string, unknown> = {}) {
  return {
    commit: vi.fn(async () => ({ success: true, operation: 'commit', commitHash: 'abc1234', commitTitle: 'feat: x' })),
    commitWithMessage: vi.fn(async () => ({ success: true, operation: 'commit', commitHash: 'def5678', commitTitle: 'wip 随手一改' })),
    ...overrides,
  } as any
}

describe('useGitOperations commit-with-message', () => {
  beforeEach(() => {
    vi.mocked(ElMessage.success).mockClear()
    vi.mocked(ElMessage.error).mockClear()
  })

  it('透传 message 与 repoPath，成功 toast 含短哈希与标题', async () => {
    const p = stubProvider()
    const { run } = useGitOperations(ref(p))

    const result = await run('commit-with-message', 'wip 随手一改', 'sub-repo')

    expect(p.commitWithMessage).toHaveBeenCalledWith('wip 随手一改', 'sub-repo')
    expect(result?.success).toBe(true)
    expect(ElMessage.success).toHaveBeenCalledWith('提交成功 def5678：wip 随手一改')
  })

  it('失败只 toast 具体原因，不向调用方抛错', async () => {
    const p = stubProvider({ commitWithMessage: vi.fn(async () => ({ success: false, operation: 'commit', error: '提交信息不能为空' })) })
    const { run } = useGitOperations(ref(p))

    const result = await run('commit-with-message', '   ')

    expect(result?.success).toBe(false)
    expect(ElMessage.error).toHaveBeenCalledWith('提交信息不能为空')
  })

  it('provider 缺失时直接返回 null', async () => {
    const { run } = useGitOperations(ref(null))
    expect(await run('commit-with-message', 'x')).toBeNull()
  })

  it('在途时第二次调用直接返回 null（与一步提交共用防重入）', async () => {
    let resolveFirst: (value: unknown) => void = () => {}
    const p = stubProvider({ commitWithMessage: vi.fn(() => new Promise((resolve) => { resolveFirst = resolve })) })
    const { run } = useGitOperations(ref(p))

    const first = run('commit-with-message', '第一条')
    expect(await run('commit-with-message', '第二条')).toBeNull()

    resolveFirst({ success: true, operation: 'commit', commitHash: 'aaa', commitTitle: '第一条' })
    expect((await first)?.success).toBe(true)
    expect(p.commitWithMessage).toHaveBeenCalledTimes(1)
    expect(p.commitWithMessage).toHaveBeenCalledWith('第一条')
  })
})
