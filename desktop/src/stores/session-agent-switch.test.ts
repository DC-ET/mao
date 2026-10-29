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

const mockPatch = vi.mocked(api.patch)

describe('session store updateSessionAgent', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockPatch.mockReset()
  })

  it('用服务端返回的 agentId/agentName 更新本地实体', async () => {
    const store = useSessionStore()
    store.updateSession('7', { id: '7', agentId: '1', agentName: '旧', executionMode: 'CLOUD' })
    mockPatch.mockResolvedValue({ data: { agentId: 5, agentName: '新' } } as never)

    await store.updateSessionAgent('7', 5)

    expect(mockPatch).toHaveBeenCalledWith('/sessions/7', { agentId: 5 })
    expect(store.sessions.find(s => s.id === '7')?.agentId).toBe('5')
    expect(store.sessions.find(s => s.id === '7')?.agentName).toBe('新')
  })

  it('PATCH 失败时不上报本地变更（乐观更新留给了调用方回滚）', async () => {
    const store = useSessionStore()
    store.updateSession('7', { id: '7', agentId: '1', agentName: '旧', executionMode: 'CLOUD' })
    mockPatch.mockRejectedValue(new Error('该 Agent 已停用'))

    await expect(store.updateSessionAgent('7', 5)).rejects.toThrow('该 Agent 已停用')
    expect(store.sessions.find(s => s.id === '7')?.agentId).toBe('1')
    expect(store.sessions.find(s => s.id === '7')?.agentName).toBe('旧')
  })
})
