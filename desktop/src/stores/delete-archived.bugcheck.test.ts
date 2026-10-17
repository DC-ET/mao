import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useSessionStore } from './session'
import { api } from '../api'

vi.mock('../api', () => ({
  api: { get: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(), post: vi.fn() },
}))

const mockGet = vi.mocked(api.get)
const mockDelete = vi.mocked(api.delete)

function makeSession(id: string, overrides: Record<string, any> = {}): any {
  return {
    id,
    agentId: '1',
    agentName: 'a',
    title: `t${id}`,
    executionMode: 'CLOUD',
    status: 'ACTIVE',
    phase: 'IDLE',
    createdAt: '2026-08-01T00:00:00',
    updatedAt: '2026-08-01T00:00:00',
    messageCount: 0,
    elapsedMs: 0,
    running: false,
    ...overrides,
  }
}

/** 活跃区同分组 1 条 + 已归档区同分组 2 条。 */
async function setup() {
  const store = useSessionStore()
  mockGet.mockResolvedValueOnce({
    data: {
      groups: [{
        key: 'CLOUD:临时工作区',
        label: '临时工作区',
        total: 1,
        hasMore: false,
        sessions: [makeSession('1')],
      }],
    },
  })
  await store.fetchSessions()
  mockGet.mockResolvedValueOnce({
    data: {
      groups: [{
        key: 'CLOUD:临时工作区',
        label: '临时工作区',
        total: 2,
        hasMore: false,
        sessions: [makeSession('9', { status: 'ARCHIVED' }), makeSession('8', { status: 'ARCHIVED' })],
      }],
    },
  })
  await store.fetchArchivedSessions()
  return store
}

describe('删除已归档会话后的分组计数', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mockGet.mockReset()
    mockDelete.mockReset()
  })

  it('对照组：删除前活跃 1、归档 2', async () => {
    const store = await setup()
    expect(store.getGroupMeta('CLOUD:临时工作区')!.total).toBe(1)
    expect(store.archivedGroupMeta.get('CLOUD:临时工作区')!.total).toBe(2)
  })

  it('回归：删除归档会话不应扣减活跃分组 total', async () => {
    const store = await setup()
    mockDelete.mockResolvedValueOnce({ data: undefined })
    expect(await store.deleteSession('9')).toBe(true)
    // 当前实现走 bumpGroupMetaForSession(existing, -1) → 活跃分组变成 0
    expect(store.getGroupMeta('CLOUD:临时工作区')!.total).toBe(1)
  })

  it('回归：删除归档会话应扣减归档分组 total（归档徽标数据源）', async () => {
    const store = await setup()
    mockDelete.mockResolvedValueOnce({ data: undefined })
    expect(await store.deleteSession('9')).toBe(true)
    // 当前实现从不写 archivedGroupMeta → 保持 2
    expect(store.archivedGroupMeta.get('CLOUD:临时工作区')!.total).toBe(1)
  })
})
