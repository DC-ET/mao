import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionStore } from './session'
import { api } from '../api'

vi.mock('../api', () => ({
  api: {
    get: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    post: vi.fn(),
  },
}))

const mockPost = vi.mocked(api.post)

function mockCreated(id = '9'): void {
  mockPost.mockResolvedValue({
    data: { id, agentId: '1', agentName: 'a', executionMode: 'CLOUD', workspace: '/root/7/123' },
  } as never)
}

/** CLOUD 新建会话 payload（技术方案 2026-10-29：总览「用于新任务」带入显式工作区） */
describe('session store createSession CLOUD 显式工作区', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockPost.mockReset()
  })

  it('带入的绝对路径原样进入 payload（不再被 CLOUD 分支丢弃）', async () => {
    const store = useSessionStore()
    mockCreated()
    await store.createSession('1', 'CLOUD', '/root/7/123')
    const [url, payload] = mockPost.mock.calls[0] as [string, Record<string, unknown>]
    expect(url).toBe('/sessions')
    expect(payload.workspace).toBe('/root/7/123')
  })

  it('常规新建态（无显式路径）不写 workspace，走后端自动建目录', async () => {
    const store = useSessionStore()
    mockCreated()
    await store.createSession('1', 'CLOUD', undefined, undefined, undefined, undefined, 'demo', 'existing')
    const [, payload] = mockPost.mock.calls[0] as [string, Record<string, unknown>]
    expect(payload.workspace).toBeUndefined()
    expect(payload.workspaceMode).toBe('existing')
    expect(payload.cloudProjectKey).toBe('demo')
  })

  it('git 克隆模式互斥：即使传入路径也不写 workspace（否则后端跳过 clone）', async () => {
    const store = useSessionStore()
    mockCreated()
    await store.createSession('1', 'CLOUD', '/root/7/123', undefined, undefined, undefined, undefined, 'git', 'https://git.example.com/x/y.git')
    const [, payload] = mockPost.mock.calls[0] as [string, Record<string, unknown>]
    expect(payload.workspace).toBeUndefined()
    expect(payload.gitCloneUrl).toBe('https://git.example.com/x/y.git')
  })

  it('LOCAL 模式仍写 workspace（行为不回退）', async () => {
    const store = useSessionStore()
    mockPost.mockResolvedValue({ data: { id: '9', executionMode: 'LOCAL', workspace: '/Users/x/p' } } as never)
    await store.createSession('1', 'LOCAL', '/Users/x/p')
    const [, payload] = mockPost.mock.calls[0] as [string, Record<string, unknown>]
    expect(payload.workspace).toBe('/Users/x/p')
  })
})
