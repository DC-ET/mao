import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { isCurrentChatSession, useChat } from './useChat'
import { api } from '../api'
import { useSessionStore } from '../stores/session'

const ws = vi.hoisted(() => ({
  connect: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(),
  cancel: vi.fn(),
  pendingCallbacks: new Map(), onMessageSaved: vi.fn(), offMessageSaved: vi.fn(),
  sendEditMessage: vi.fn(),
  setActiveExecution: vi.fn(), clearActiveExecution: vi.fn(),
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
    // setQueueMessages 会把 sessionId 回填成当前会话（见 stores/session/messages.ts），
    // 慢响应不得把旧会话的行改写成切换后的会话。
    expect(store.getQueueMessages('A')).toEqual([{ id: 'qa', sessionId: 'A' }])
    expect(store.getQueueMessages('B')).toEqual([{ id: 'qb', sessionId: 'B' }])
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

  // round 1 BUG-3：编辑重发曾用 appendMessage 追加未注册的流式占位气泡，首个
  // content_delta 认不出尾部是自己的气泡 → 新建一条，同一轮回复被劈成
  // 「空气泡 + 新气泡」（流式期间多出一条空 assistant，回合步骤计数 +1）。
  // 必须走 ensureStreamingAssistantMessage 写进流式注册表，与 prepareAndSendMessage 同口径。
  it('首个 content_delta 必须落到重发自带的占位气泡上，不劈出空气泡', async () => {
    vi.mocked(api.get).mockResolvedValue({ data: { messages: [], hasMore: false } } as never)
    const store = useSessionStore()
    store.setMessages('9', [
      { id: '100', role: 'user', content: '写个快排', createdAt: '2026-10-13 10:00:00' },
      { id: '201', role: 'assistant', content: '旧回复', createdAt: '2026-10-13 10:00:05' },
    ])
    store.setActiveSession('9')

    const chat = useChat(ref('1'), ref('CLOUD'))
    chat.sessionId.value = '9'

    const pending = chat.editAndResend('100', '改写个堆排序')
    await vi.waitFor(() => expect(ws.sendEditMessage).toHaveBeenCalled())

    // 服务端重新执行，首包 content_delta 到达（routeEvent → store.appendDelta）
    store.appendDelta('9', '新的堆排序实现：')

    const during = store.getMessages('9')
    // 截断后应只有 [user, 占位气泡]，首包 delta 复用占位气泡，
    // 不得出现「空气泡 + 新气泡」两条 assistant
    expect(during.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(during[1].content).toContain('堆排序')

    // 收尾：执行完成，解开 editAndResend 的等待
    ws.pendingCallbacks.get('9')?.resolve?.()
    await pending
  })
})

// round 1 BUG-1：文本流式中点「停止」→ 终态重拉先于服务端 CANCELLED 帧落地。
// stopExecution 只清 sending/streaming 标志不打中断标记时，phase watcher 的终态
// 重拉（REST 先于服务端 CANCELLED 广播落地）会把气泡当「REST 覆盖范围的尾部残留」
// 删掉，迟到的 CANCELLED 帧再标记已空转——已流出的半段回复凭空消失
// （服务端不落库被中止轮次，流式气泡是唯一副本）。
describe('stopExecution', () => {
  /** 等服务端历史响应（REST GET 在停止点击后一个 tick 内即发出）落地。 */
  async function flushRest() {
    for (let i = 0; i < 5; i++) {
      await Promise.resolve()
    }
    await new Promise(resolve => setTimeout(resolve, 0))
  }

  /** 被中止轮次服务端不落库：REST 历史只有用户消息，没有那条部分回复。 */
  const restWithoutReply = () => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === '/sessions/9/messages') {
        return Promise.resolve({
          data: { messages: [{ id: 100, role: 'user', content: '写个快排' }], hasMore: false },
        } as never)
      }
      if (url === '/sessions/9/queue') return Promise.resolve({ data: [] } as never)
      return Promise.resolve({ data: null } as never)
    })
  }

  const seedStreaming = (store: ReturnType<typeof useSessionStore>) => {
    store.setMessages('9', [{
      id: '100', role: 'user', content: '写个快排', createdAt: '2026-10-13 10:00:00',
    }])
    store.ensureStreamingAssistantMessage('9')
    store.appendDelta('9', '好的，这是快速排序实现：')
    store.updateSessionPhase('9', 'RUNNING')
    store.setActiveSession('9')
  }

  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    ws.cancel.mockResolvedValue(true)
    restWithoutReply()
  })

  it('部分流式回复不得因「先重拉、后收 CANCELLED 帧」而丢失', async () => {
    const store = useSessionStore()
    seedStreaming(store)

    const chat = useChat(ref('1'), ref('CLOUD'))
    chat.sessionId.value = '9'

    await chat.stopExecution()
    // 等 watcher 触发的终态 fetchMessages() 的 REST 响应落地（停止点击后一个 tick 内）
    await flushRest()

    // 服务端 CANCELLED 广播要晚几个 DB 跳数才到
    store.finishInterruptedStreamingMessage('9', '执行已被中止')

    const msgs = store.getMessages('9')
    // 已流出的部分回复是唯一副本，必须保留可见
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1].content).toContain('快速排序')
  })

  it('对照组 A（顺序正确）：CANCELLED 帧先打中断标记、后终态重拉，部分回复保留', async () => {
    const store = useSessionStore()
    seedStreaming(store)

    const chat = useChat(ref('1'), ref('CLOUD'))
    chat.sessionId.value = '9'

    await chat.stopExecution()
    // 服务端 CANCELLED 帧先到：打中断标记 + 删注册
    store.finishInterruptedStreamingMessage('9', '执行已被中止')
    await flushRest()

    const msgs = store.getMessages('9')
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1].content).toContain('快速排序')
  })

  it('对照组 B（正常完成）：REST 含完整 assistant，终态重拉后不重复、不残留', async () => {
    vi.mocked(api.get).mockImplementation((url: string) => {
      if (url === '/sessions/9/messages') {
        // 正常完成：服务端已落库完整回复（id 201）
        return Promise.resolve({
          data: {
            messages: [
              { id: 100, role: 'user', content: '写个快排' },
              { id: 201, role: 'assistant', content: '好的，这是快速排序实现：' },
            ],
            hasMore: false,
          },
        } as never)
      }
      if (url === '/sessions/9/queue') return Promise.resolve({ data: [] } as never)
      return Promise.resolve({ data: null } as never)
    })
    const store = useSessionStore()
    seedStreaming(store)

    const chat = useChat(ref('1'), ref('CLOUD'))
    chat.sessionId.value = '9'

    await chat.stopExecution()
    await flushRest()

    const msgs = store.getMessages('9')
    expect(msgs.map(m => m.role)).toEqual(['user', 'assistant'])
    // 以 REST 落库版本为准，本地流式占位气泡不得留下重复副本
    expect(msgs[1].id).toBe('201')
    expect(msgs.filter(m => m.role === 'assistant')).toHaveLength(1)
  })
})
