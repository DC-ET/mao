import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { isCurrentChatSession, useChat } from './useChat'
import { api } from '../api'
import { useSessionStore } from '../stores/session'

const ws = vi.hoisted(() => ({
  connect: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(),
  pendingCallbacks: new Map(), onMessageSaved: vi.fn(), offMessageSaved: vi.fn(),
  sendEditMessage: vi.fn(),
}))
vi.mock('./useStreamWS', () => ({ useStreamWS: () => ws }))
vi.mock('./useToolApprovals', () => ({ useToolApprovals: () => ({
  pendingApprovals: ref([]), clearPendingApprovals: vi.fn(),
}) }))
vi.mock('../api', () => ({ api: { get: vi.fn() } }))
vi.mock('element-plus', () => ({ ElMessage: { warning: vi.fn(), error: vi.fn() } }))
vi.mock('../utils/localSkills', () => ({ collectLocalUnsyncedSkills: vi.fn(async () => []) }))
vi.mock('../utils/agentsMd', () => ({ collectAgentsMdContent: vi.fn(async () => undefined) }))

describe('restoreSession', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ws.connect.mockResolvedValue(undefined)
    vi.mocked(api.get).mockResolvedValue({ data: [] } as never)
  })

  it('等待历史消息加载完成才完成恢复', async () => {
    let resolve!: (value: any) => void
    vi.mocked(api.get).mockImplementation((url: string) => url.endsWith('/messages')
      ? new Promise(r => { resolve = r }) : Promise.resolve({ data: [] }))
    const chat = useChat(ref('1'), ref('CLOUD'))
    let completed = false
    const pending = chat.restoreSession('A', 'CLOUD').then(() => { completed = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(completed).toBe(false)
    expect(chat.switchingSession.value).toBe(true)
    resolve({ data: { messages: [], hasMore: false } })
    await pending
    expect(completed).toBe(true)
    expect(chat.switchingSession.value).toBe(false)
  })

  it('连接挂起时进入新任务，不再订阅或加载旧会话', async () => {
    let resolve!: () => void
    ws.connect.mockImplementationOnce(() => new Promise<void>(r => { resolve = r }))
    const chat = useChat(ref('1'), ref('CLOUD'))
    const pending = chat.restoreSession('A', 'CLOUD')
    chat.newSession()
    resolve()
    await pending
    expect(ws.subscribe).not.toHaveBeenCalled()
    expect(api.get).not.toHaveBeenCalled()
    expect(chat.sessionId.value).toBeNull()
    expect(chat.switchingSession.value).toBe(false)
  })

  it('历史请求失败后结束加载状态', async () => {
    vi.mocked(api.get).mockRejectedValue(new Error('network error'))
    const chat = useChat(ref('1'), ref('CLOUD'))
    await chat.restoreSession('A', 'CLOUD')
    expect(chat.switchingSession.value).toBe(false)
  })

  it('快速切换时旧请求完成不会提前结束当前会话的加载状态', async () => {
    const resolves = new Map<string, (value: any) => void>()
    vi.mocked(api.get).mockImplementation((url: string) => url.endsWith('/messages')
      ? new Promise(resolve => { resolves.set(url, resolve) })
      : Promise.resolve({ data: [] }))
    const chat = useChat(ref('1'), ref('CLOUD'))
    const first = chat.restoreSession('A', 'CLOUD')
    await Promise.resolve()
    const second = chat.restoreSession('B', 'CLOUD')
    await Promise.resolve()
    resolves.get('/sessions/A/messages')!({ data: { messages: [], hasMore: false } })
    await first
    expect(chat.switchingSession.value).toBe(true)
    expect(chat.sessionId.value).toBe('B')
    resolves.get('/sessions/B/messages')!({ data: { messages: [], hasMore: false } })
    await second
    expect(chat.switchingSession.value).toBe(false)
  })

  it('待办与队列慢响应写入原会话，不覆盖切换后的会话', async () => {
    const delayed = new Map<string, (value: unknown) => void>()
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url.endsWith('/messages')) return Promise.resolve({ data: { messages: [], hasMore: false } })
      if (url.endsWith('/todos') || url.endsWith('/queue')) {
        return new Promise(resolve => { delayed.set(url, resolve) })
      }
      return Promise.resolve({ data: [] })
    })
    const store = useSessionStore()
    const chat = useChat(ref('1'), ref('CLOUD'))
    await chat.restoreSession('A', 'CLOUD')
    await chat.restoreSession('B', 'CLOUD')

    delayed.get('/sessions/B/todos')!({ data: [{ id: 2, content: 'B todo' }] })
    delayed.get('/sessions/B/queue')!({ data: [{ id: 'qb' }] })
    await Promise.resolve()
    delayed.get('/sessions/A/todos')!({ data: [{ id: 1, content: 'A todo' }] })
    delayed.get('/sessions/A/queue')!({ data: [{ id: 'qa' }] })
    await Promise.resolve()
    await Promise.resolve()

    expect(store.getTodos('A')).toEqual([{ id: 1, content: 'A todo' }])
    expect(store.getTodos('B')).toEqual([{ id: 2, content: 'B todo' }])
    expect(store.getQueueMessages('A')).toEqual([{ id: 'qa' }])
    expect(store.getQueueMessages('B')).toEqual([{ id: 'qb' }])
  })

  it('历史上拉合并目标会话自身的文件变更，不混入当前会话', async () => {
    let resolveOlder!: (value: unknown) => void
    vi.mocked(api.get).mockImplementation((url: string, config?: { params?: { beforeMessageId?: unknown } }) => {
      if (url === '/sessions/A/messages' && config?.params?.beforeMessageId) {
        return new Promise(resolve => { resolveOlder = resolve })
      }
      if (url === '/sessions/A/messages') {
        return Promise.resolve({
          data: {
            messages: [{
              id: 10, role: 'ASSISTANT', content: 'current A',
              fileChanges: [{ path: 'a.ts', type: 'MODIFIED', linesAdded: 1, linesDeleted: 0 }],
            }],
            hasMore: true,
            nextBeforeMessageId: 5,
          },
        })
      }
      if (url === '/sessions/B/messages') {
        return Promise.resolve({
          data: {
            messages: [{
              id: 20, role: 'ASSISTANT', content: 'current B',
              fileChanges: [{ path: 'b.ts', type: 'MODIFIED', linesAdded: 2, linesDeleted: 0 }],
            }],
            hasMore: false,
          },
        })
      }
      return Promise.resolve({ data: [] })
    })
    const store = useSessionStore()
    const chat = useChat(ref('1'), ref('CLOUD'))
    await chat.restoreSession('A', 'CLOUD')
    const older = chat.loadOlderMessages()
    await chat.restoreSession('B', 'CLOUD')
    resolveOlder({
      data: {
        messages: [{
          id: 5, role: 'ASSISTANT', content: 'old A',
          fileChanges: [{ path: 'old.ts', type: 'CREATED', linesAdded: 3, linesDeleted: 0 }],
        }],
        hasMore: false,
      },
    })
    await older
    expect(store.getFileChanges('A').map(c => c.path)).toEqual(['old.ts', 'a.ts'])
    expect(store.getFileChanges('B').map(c => c.path)).toEqual(['b.ts'])
  })

  it('历史上拉时当前会话无文件变更也不会丢掉目标会话近期变更', async () => {
    let resolveOlder!: (value: unknown) => void
    vi.mocked(api.get).mockImplementation((url: string, config?: { params?: { beforeMessageId?: unknown } }) => {
      if (url === '/sessions/A/messages' && config?.params?.beforeMessageId) {
        return new Promise(resolve => { resolveOlder = resolve })
      }
      if (url === '/sessions/A/messages') {
        return Promise.resolve({
          data: {
            messages: [{
              id: 10, role: 'ASSISTANT', content: 'current A',
              fileChanges: [{ path: 'a.ts', type: 'MODIFIED', linesAdded: 1, linesDeleted: 0 }],
            }],
            hasMore: true,
            nextBeforeMessageId: 5,
          },
        })
      }
      if (url === '/sessions/B/messages') {
        return Promise.resolve({ data: { messages: [], hasMore: false } })
      }
      return Promise.resolve({ data: [] })
    })
    const store = useSessionStore()
    const chat = useChat(ref('1'), ref('CLOUD'))
    await chat.restoreSession('A', 'CLOUD')
    const older = chat.loadOlderMessages()
    await chat.restoreSession('B', 'CLOUD')
    resolveOlder({
      data: {
        messages: [{
          id: 5, role: 'ASSISTANT', content: 'old A',
          fileChanges: [{ path: 'old.ts', type: 'CREATED', linesAdded: 3, linesDeleted: 0 }],
        }],
        hasMore: false,
      },
    })
    await older
    expect(store.getFileChanges('A').map(c => c.path)).toEqual(['old.ts', 'a.ts'])
    expect(store.getFileChanges('B')).toEqual([])
  })
})

describe('isCurrentChatSession', () => {
  it('仅允许本地、活动和预期会话完全一致时发送', () => {
    expect(isCurrentChatSession('1306', '1306', '1306', false)).toBe(true)
    expect(isCurrentChatSession(null, null, null, false)).toBe(true)
  })

  it('会话切换或任一会话 ID 错配时拒绝发送', () => {
    expect(isCurrentChatSession('1304', '1306', '1306', false)).toBe(false)
    expect(isCurrentChatSession('1306', '1304', '1306', false)).toBe(false)
    expect(isCurrentChatSession('1306', '1306', '1306', true)).toBe(false)
  })
})

describe('editAndResend', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ws.connect.mockResolvedValue(undefined)
    ws.sendEditMessage.mockResolvedValue(true)
    vi.mocked(api.get).mockResolvedValue({ data: {} } as never)
  })

  it('失败回滚写入编辑目标会话，不覆盖已切换的会话', async () => {
    const store = useSessionStore()
    store.setMessages('A', [
      { id: 'u1', role: 'user', content: 'old A', createdAt: '2026-09-17 12:00:00' },
      { id: 'a1', role: 'assistant', content: 'reply A', createdAt: '2026-09-17 12:00:01' },
    ])
    store.setMessages('B', [
      { id: 'ub', role: 'user', content: 'B user', createdAt: '2026-09-17 12:00:00' },
    ])
    store.setActiveSession('A')
    const chat = useChat(ref('1'), ref('CLOUD'))
    chat.sessionId.value = 'A'

    let finishSend!: (ok: boolean) => void
    ws.sendEditMessage.mockImplementation(() => new Promise<boolean>(resolve => { finishSend = resolve }))

    const pending = chat.editAndResend('u1', 'edited A')
    await vi.waitFor(() => expect(ws.sendEditMessage).toHaveBeenCalled())

    chat.sessionId.value = 'B'
    store.setActiveSession('B')
    finishSend(false)
    await pending

    expect(store.getMessages('B').map(m => m.content)).toEqual(['B user'])
    expect(store.getMessages('A').map(m => m.content)).toEqual(['old A', 'reply A'])
  })
})
