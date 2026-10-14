// 本地 Git 提交失败原因透传回归用例（2026-10-13 round3 BUG-5）。
//
// 原缺陷：gitCommitInput 的失败契约是返回 { error: string }（字符串），
// 而 failedOperation 只对 Error 实例保留 message，直接传字符串会被换成
// 笼统的「Git 操作失败」，排障时看不到真实原因。
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('../api', () => ({
  api: {
    get: vi.fn(async () => ({ code: 0, data: [] })),
    post: vi.fn(async () => ({ code: 0, data: {} })),
    put: vi.fn(async () => ({ code: 0, data: {} })),
    delete: vi.fn(async () => ({ code: 0, data: {} })),
  },
}))

import { createLocalGitProvider } from './workspace-git-provider'

describe('createLocalGitProvider.commit', () => {
  beforeEach(() => {
    ;(globalThis as any).window = { electronAPI: {} }
  })

  it('gitCommitInput 解析仓库失败时透传具体原因，而不是笼统的「Git 操作失败」', async () => {
    // Electron 侧 buildCommitInput 在 resolveRepository 抛错时返回 { error: message }（字符串）。
    const gitCommitInput = vi.fn(async () => ({ error: '当前工作区不是 Git 仓库' }))
    ;(globalThis as any).window = { electronAPI: { gitCommitInput } }

    const provider = createLocalGitProvider('/tmp/ws', '1')
    const result = await provider.commit()

    expect(result.success).toBe(false)
    expect(result.error).toBe('当前工作区不是 Git 仓库')
  });

  it('多仓库模式下所选子仓库被外部删除时同样透传原因', async () => {
    const gitCommitInput = vi.fn(async () => ({ error: '目录不存在' }))
    ;(globalThis as any).window = { electronAPI: { gitCommitInput } }

    const provider = createLocalGitProvider('/tmp/ws', '1')
    const result = await provider.commit('sub-repo')

    expect(result.success).toBe(false)
    expect(result.error).toBe('目录不存在')
  });
})
