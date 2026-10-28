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

import { createCloudGitProvider, createLocalGitProvider } from './workspace-git-provider'
import { api } from '../api'

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

// ===== Git 管理器中央 Tab：provider 九方法（LOCAL IPC / CLOUD REST） =====

describe('createLocalGitProvider git manager methods', () => {
  beforeEach(() => {
    vi.mocked(api.post).mockClear()
    vi.mocked(api.get).mockClear()
    ;(globalThis as any).window = { electronAPI: {} }
  })

  it('getLog 透传分页参数与 repoPath，解包数组', async () => {
    const gitLog = vi.fn(async () => [{ hash: 'h', shortHash: 'h', title: 't', author: 'a', date: 'd' }])
    ;(globalThis as any).window = { electronAPI: { gitLog } }
    const provider = createLocalGitProvider('/tmp/ws', '1')

    const entries = await provider.getLog({ limit: 50, offset: 100 }, 'sub-repo')
    expect(gitLog).toHaveBeenCalledWith('/tmp/ws', 'sub-repo', { limit: 50, offset: 100 })
    expect(entries).toHaveLength(1)
  })

  it('读方法遇 IPC { error } 抛错，供各视图展示错误 + 重试', async () => {
    const gitLog = vi.fn(async () => ({ error: '当前工作区不是 Git 仓库' }))
    ;(globalThis as any).window = { electronAPI: { gitLog } }
    const provider = createLocalGitProvider('/tmp/ws', '1')
    await expect(provider.getLog()).rejects.toThrow('当前工作区不是 Git 仓库')
  })

  it('getCommitFiles 归一化返回，缺失字段兜底', async () => {
    const gitCommitFiles = vi.fn(async () => ({ hash: 'abc', files: [{ path: 'a', changeType: 'MODIFIED', insertions: 1, deletions: 0 }] }))
    ;(globalThis as any).window = { electronAPI: { gitCommitFiles } }
    const provider = createLocalGitProvider('/tmp/ws', '1')

    const result = await provider.getCommitFiles('abc1234', 'sub-repo')
    expect(gitCommitFiles).toHaveBeenCalledWith('/tmp/ws', 'sub-repo', 'abc1234')
    expect(result.files).toHaveLength(1)

    const gitCommitFilesBad = vi.fn(async () => ({ error: '提交不存在' }))
    ;(globalThis as any).window = { electronAPI: { gitCommitFiles: gitCommitFilesBad } }
    await expect(createLocalGitProvider('/tmp/ws', '1').getCommitFiles('abc1234')).rejects.toThrow('提交不存在')
  })

  it('getCommitFileDiff 归一化 before/after', async () => {
    const gitCommitFileDiff = vi.fn(async () => ({ path: 'a', changeType: 'MODIFIED', beforeContent: 'x\n', afterContent: 'y\n' }))
    ;(globalThis as any).window = { electronAPI: { gitCommitFileDiff } }
    const provider = createLocalGitProvider('/tmp/ws', '1')

    const diff = await provider.getCommitFileDiff('abc1234', 'a.txt', 'sub-repo')
    expect(gitCommitFileDiff).toHaveBeenCalledWith('/tmp/ws', 'sub-repo', 'abc1234', 'a.txt', undefined)
    expect(diff.afterContent).toBe('y\n')

    // 改名提交必须把 oldPath 透传到 IPC：before 取自父提交的旧路径
    await provider.getCommitFileDiff('abc1234', 'b.txt', 'sub-repo', 'a.txt')
    expect(gitCommitFileDiff).toHaveBeenLastCalledWith('/tmp/ws', 'sub-repo', 'abc1234', 'b.txt', 'a.txt')
  })

  it('getBranches/getStashes/getRemotes 解包数组', async () => {
    const gitBranches = vi.fn(async () => [{ name: 'main', isCurrent: true, isRemote: false }])
    const gitStashes = vi.fn(async () => [{ ref: 'stash@{0}', message: 'wip', date: 'd' }])
    const gitRemotes = vi.fn(async () => [{ name: 'origin', fetchUrl: 'u', pushUrl: 'u' }])
    ;(globalThis as any).window = { electronAPI: { gitBranches, gitStashes, gitRemotes } }
    const provider = createLocalGitProvider('/tmp/ws', '1')

    expect(await provider.getBranches('r')).toHaveLength(1)
    expect(await provider.getStashes('r')).toHaveLength(1)
    expect(await provider.getRemotes('r')).toHaveLength(1)
    expect(gitBranches).toHaveBeenCalledWith('/tmp/ws', 'r')
  })

  it('fetchRemote/switchBranch/stashOp 成功后落 LOCAL 活动记录', async () => {
    const gitFetch = vi.fn(async () => ({ success: true, operation: 'fetch', message: '远端已更新' }))
    const gitSwitchBranch = vi.fn(async () => ({ success: true, operation: 'switch', branch: 'main' }))
    const gitStashOp = vi.fn(async () => ({ success: true, operation: 'stash', message: '已应用 stash@{0}' }))
    ;(globalThis as any).window = { electronAPI: { gitFetch, gitSwitchBranch, gitStashOp } }
    const provider = createLocalGitProvider('/tmp/ws', '7')

    const fetched = await provider.fetchRemote('sub-repo')
    expect(fetched.success).toBe(true)
    expect(gitFetch).toHaveBeenCalledWith('/tmp/ws', 'sub-repo')

    const switched = await provider.switchBranch('main', { create: true }, 'sub-repo')
    expect(switched.success).toBe(true)
    expect(gitSwitchBranch).toHaveBeenCalledWith('/tmp/ws', 'sub-repo', 'main', true)

    const stashed = await provider.stashOp('pop', 'stash@{0}', 'sub-repo')
    expect(stashed.success).toBe(true)
    expect(gitStashOp).toHaveBeenCalledWith('/tmp/ws', 'sub-repo', 'pop', 'stash@{0}')

    // 三个写操作各记一次活动，operation 白名称为 fetch/switch/stash
    expect(vi.mocked(api.post)).toHaveBeenCalledTimes(3)
    const operations = vi.mocked(api.post).mock.calls.map((c) => (c[1] as any).result.operation)
    expect(operations).toEqual(['fetch', 'switch', 'stash'])
  })

  it('写操作 IPC 抛错时转 failedOperation 且不中断', async () => {
    const gitFetch = vi.fn(async () => { throw new Error('fetch 失败') })
    ;(globalThis as any).window = { electronAPI: { gitFetch } }
    const provider = createLocalGitProvider('/tmp/ws', '1')

    const result = await provider.fetchRemote()
    expect(result.success).toBe(false)
    expect(result.operation).toBe('fetch')
    expect(result.error).toBe('fetch 失败')
  })
})

describe('createCloudGitProvider git manager methods', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockClear()
    vi.mocked(api.post).mockClear()
  })

  it('读方法按 REST 端点与查询参数取数，非数组兜底空列表', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: [{ hash: 'h' }] } as never)
    const provider = createCloudGitProvider('7')

    expect(await provider.getLog({ limit: 50, offset: 0 }, 'r')).toHaveLength(1)
    expect(vi.mocked(api.get).mock.calls[0]).toEqual(['/files/workspace-git-log', {
      params: { sessionId: 7, repoPath: 'r', limit: 50, offset: 0, path: undefined },
    }])

    vi.mocked(api.get).mockResolvedValue({ data: null } as never)
    expect(await provider.getBranches('r')).toEqual([])
    expect(vi.mocked(api.get).mock.calls[1]).toEqual(['/files/workspace-git-branches', { params: { sessionId: 7, repoPath: 'r' } }])
  })

  it('getCommitFileDiff 请求失败转 unavailableReason，不抛错', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('提交不存在'))
    const provider = createCloudGitProvider('7')

    const diff = await provider.getCommitFileDiff('abc1234', 'a.txt', 'r')
    expect(diff.path).toBe('a.txt')
    expect(diff.unavailableReason).toBe('提交不存在')
    expect(vi.mocked(api.get).mock.calls[0]).toEqual(['/files/workspace-git-commit-file-diff', {
      params: { sessionId: 7, repoPath: 'r', hash: 'abc1234', path: 'a.txt', oldPath: undefined },
    }])

    // 改名提交的 oldPath 进查询参数
    await createCloudGitProvider('7').getCommitFileDiff('abc1234', 'b.txt', 'r', 'a.txt')
    expect(vi.mocked(api.get).mock.calls[1]).toEqual(['/files/workspace-git-commit-file-diff', {
      params: { sessionId: 7, repoPath: 'r', hash: 'abc1234', path: 'b.txt', oldPath: 'a.txt' },
    }])
  })

  it('写方法失败转 failedOperation，保留 operation 标识', async () => {
    vi.mocked(api.post).mockRejectedValue(new Error('分支名无效'))
    const provider = createCloudGitProvider('7')

    const switched = await provider.switchBranch('bad..name', undefined, 'r')
    expect(switched.success).toBe(false)
    expect(switched.operation).toBe('switch')
    expect(switched.error).toBe('分支名无效')
    expect(vi.mocked(api.post).mock.calls[0]).toEqual(['/files/workspace-git-switch-branch', {
      sessionId: 7, repoPath: 'r', branch: 'bad..name', create: false,
    }])
  })
})
