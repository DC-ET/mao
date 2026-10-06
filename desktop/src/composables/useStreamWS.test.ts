import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../utils/auth-storage', () => ({
  getToken: () => 'test-token',
}))
vi.mock('../api', () => ({
  api: { get: vi.fn().mockResolvedValue({ data: [] }) },
  // inbox store 通过命名导出调用；这里给稳定空实现，避免 onopen 未读数重拉抛 TypeError
  fetchInboxUnreadCount: vi.fn().mockResolvedValue({ unreadCount: 0 }),
  fetchInboxList: vi.fn().mockResolvedValue({ records: [], total: 0, page: 1, size: 20 }),
  markInboxItemRead: vi.fn(),
  markInboxAllRead: vi.fn(),
  removeInboxItem: vi.fn(),
  getInboxPreference: vi.fn().mockResolvedValue({
    taskCompletedEnabled: true,
    questionPendingEnabled: true,
    approvalPendingEnabled: true,
    subagentDoneEnabled: false,
    systemNotifyEnabled: true,
  }),
  saveInboxPreference: vi.fn(),
}))

const sockets: FakeWebSocket[] = []

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  readyState = FakeWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((e: { target: unknown; data: string }) => void) | null = null
  onclose: ((e: { target: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  readonly sent: Array<Record<string, unknown>> = []
  readonly url: string

  constructor(url: string) {
    this.url = url
    sockets.push(this)
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  send(data: string) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ target: this })
  }
}

;(globalThis as any).WebSocket = FakeWebSocket

// useStreamWS 通过 window 广播 side_session_created / side_session_rejected；
// 测试跑在 node 环境，用一个最小 EventTarget 替身顶上。
class WindowEventTarget extends EventTarget {}
const windowStub = new WindowEventTarget()
Object.defineProperty(globalThis, 'window', {
  value: windowStub, writable: true, configurable: true,
})

const { useStreamWS } = await import('./useStreamWS')
const { useSessionStore } = await import('../stores/session')

type ChatMessageLike = { id: string; role: 'user' | 'assistant' | 'system'; content: string; createdAt: string; images?: string[] }

beforeEach(() => {
  setActivePinia(createPinia())
  vi.useFakeTimers()
  useStreamWS().disconnect()
  sockets.length = 0
})

afterEach(() => {
  useStreamWS().disconnect()
  sockets.length = 0
  vi.useRealTimers()
})

describe('useStreamWS reconnect', () => {
  it('重连握手失败会结束在途 connect Promise，后续连通可重新发送', async () => {
    const { connect } = useStreamWS()
    const first = connect()
    sockets[0].open()
    await first

    sockets[0].close()
    await vi.advanceTimersByTimeAsync(1000)
    expect(sockets).toHaveLength(2)

    const pendingSend = connect()
    sockets[1].close()
    await expect(pendingSend).rejects.toThrow('WebSocket connection closed')

    await vi.advanceTimersByTimeAsync(2000)
    expect(sockets).toHaveLength(3)
    sockets[2].open()
    await expect(connect()).resolves.toBeUndefined()
  })

  it('心跳判死后 onclose 迟迟不触发（半开连接）时，兜底定时器强制重连', async () => {
    const { connect, connected } = useStreamWS()
    const first = connect()
    sockets[0].open()
    await first
    expect(connected.value).toBe(true)

    // 模拟半开连接：close() 后 onclose 永远不触发
    sockets[0].close = () => {}
    // 心跳每 5s 一次，超过 30s 静默后判死并 close()
    await vi.advanceTimersByTimeAsync(35_000)
    expect(connected.value).toBe(true) // onclose 未触发，尚未走重连

    await vi.advanceTimersByTimeAsync(3_000) // 兜底：强制按断开处理
    expect(connected.value).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000) // scheduleReconnect 首轮延迟
    expect(sockets).toHaveLength(2)

    sockets[1].open()
    await expect(connect()).resolves.toBeUndefined()
    expect(connected.value).toBe(true)
  })
})

describe('useStreamWS user_message_saved', () => {
  it('side_user_ 前缀的边路任务乐观消息只替换 ID，不追加重复回显', async () => {
    const { connect, subscribe } = useStreamWS()
    const pending = connect()
    sockets[0].open()
    await pending
    await subscribe('501')

    const sessionStore = useSessionStore()
    sessionStore.addUserMessage('501', {
      id: 'side_user_1786850982000',
      role: 'user',
      content: '/var/log/btmp1 看下这个文件是什么文件',
      createdAt: '2026-09-20 19:21:12',
    } satisfies ChatMessageLike)

    sockets[0].onmessage?.({
      target: sockets[0],
      data: JSON.stringify({
        type: 'user_message_saved',
        sessionId: 501,
        data: { content: '/var/log/btmp1 看下这个文件是什么文件', messageId: 77 },
      }),
    })

    const msgs = (sessionStore.getMessages('501') ?? []) as ChatMessageLike[]
    expect(msgs.filter(m => m.role === 'user')).toHaveLength(1)
    expect(msgs[0].id).toBe('77')
  })

  it('msg_ 前缀的主会话乐观消息同样只替换 ID，不追加重复回显', async () => {
    const { connect, subscribe } = useStreamWS()
    const pending = connect()
    sockets[0].open()
    await pending
    await subscribe('9')

    const sessionStore = useSessionStore()
    sessionStore.addUserMessage('9', {
      id: 'msg_1786850982000_user',
      role: 'user',
      content: '你好',
      createdAt: '2026-09-20 19:21:12',
    })

    sockets[0].onmessage?.({
      target: sockets[0],
      data: JSON.stringify({
        type: 'user_message_saved',
        sessionId: 9,
        data: { content: '你好', messageId: 88 },
      }),
    })

    const msgs = (sessionStore.getMessages('9') ?? []) as ChatMessageLike[]
    expect(msgs.filter(m => m.role === 'user')).toHaveLength(1)
    expect(msgs[0].id).toBe('88')
  })

  it('纯图片乐观消息不会把带文字的远端消息吞掉', async () => {
    const { connect, subscribe } = useStreamWS()
    const pending = connect()
    sockets[0].open()
    await pending
    await subscribe('9')

    const sessionStore = useSessionStore()
    sessionStore.addUserMessage('9', {
      id: 'msg_1786850982000_user',
      role: 'user',
      content: '',
      createdAt: '2026-09-20 19:21:12',
      images: ['blob:local'],
    })

    sockets[0].onmessage?.({
      target: sockets[0],
      data: JSON.stringify({
        type: 'user_message_saved',
        sessionId: 9,
        data: { content: '另一端发来的文字', messageId: 99 },
      }),
    })

    const msgs = (sessionStore.getMessages('9') ?? []) as ChatMessageLike[]
    const users = msgs.filter(m => m.role === 'user')
    expect(users).toHaveLength(2)
    expect(users[0].id).toBe('msg_1786850982000_user')
    expect(users[1].content).toBe('另一端发来的文字')
    expect(users[1].id).toBe('99')
  })

  it('连续两组提问按到达顺序保留，后到的不清空先到的', async () => {
    const { connect, subscribe } = useStreamWS()
    const pending = connect()
    sockets[0].open()
    await pending
    await subscribe('9')

    const sessionStore = useSessionStore()
    const push = (requestId: string) => {
      sockets[0].onmessage?.({
        target: sockets[0],
        data: JSON.stringify({
          type: 'ask_user_questions',
          sessionId: 9,
          data: { requestId, questions: [{ id: requestId, prompt: requestId }] },
        }),
      })
    }
    push('first')
    push('second')

    const queued = sessionStore.sessionPendingQuestions.get('9') ?? []
    expect(queued.map(q => q.requestId)).toEqual(['first', 'second'])
  })
})

describe('useStreamWS side session creation', () => {
  it('createSideSession 带切点时才下发 forkFromMessageId', async () => {
    const { connect, createSideSession } = useStreamWS()
    const pending = connect()
    sockets[0].open()
    await pending

    await createSideSession('11', '继续深挖', 'fork', 3, undefined, undefined, [], 'READ_ONRITE' as string, 77)
    await createSideSession('11', '全量分叉', 'fork')

    const sideSends = sockets[0].sent.filter(m => m.type === 'create_side_session')
    expect(sideSends).toHaveLength(2)
    expect((sideSends[0].data as Record<string, unknown>).forkFromMessageId).toBe(77)
    expect((sideSends[1].data as Record<string, unknown>).forkFromMessageId).toBeUndefined()
  })

  it('创建被拒时抛 side_session_rejected 事件，且不把父会话标成 FAILED', async () => {
    const { connect, subscribe } = useStreamWS()
    const pending = connect()
    sockets[0].open()
    await pending
    await subscribe('11')

    const sessionStore = useSessionStore()
    sessionStore.updateSessionPhase('11', 'RUNNING')
    const events: CustomEvent[] = []
    const listener = (e: Event) => events.push(e as CustomEvent)
    window.addEventListener('side_session_rejected', listener)

    sockets[0].onmessage?.({
      target: sockets[0],
      data: JSON.stringify({
        type: 'error',
        sessionId: 11,
        data: { message: '分叉来源消息不存在或已被删除，请刷新后重试', code: 'side_session_rejected' },
      }),
    })
    window.removeEventListener('side_session_rejected', listener)

    expect(events).toHaveLength(1)
    expect(events[0].detail).toEqual({
      message: '分叉来源消息不存在或已被删除，请刷新后重试',
      parentSessionId: '11',
    })
    expect(sessionStore.getSessionPhase('11')).toBe('RUNNING')
  })

  it('普通 error 仍会走 FAILED 收敛路径', async () => {
    const { connect, subscribe } = useStreamWS()
    const pending = connect()
    sockets[0].open()
    await pending
    await subscribe('11')

    const sessionStore = useSessionStore()
    const events: Event[] = []
    const listener = (e: Event) => events.push(e)
    window.addEventListener('side_session_rejected', listener)

    sockets[0].onmessage?.({
      target: sockets[0],
      data: JSON.stringify({ type: 'error', sessionId: 11, data: { message: 'boom' } }),
    })
    window.removeEventListener('side_session_rejected', listener)

    expect(events).toHaveLength(0)
    expect(sessionStore.getSessionPhase('11')).toBe('FAILED')
  })
})

describe('useStreamWS inbox_updated', () => {
  it('权威未读数写入 inbox store，非 Electron 不触发系统通知', async () => {
    const { useStreamWS } = (await import('./useStreamWS')) as any
    const { connect } = useStreamWS()
    const pending = connect()
    sockets[0].open()
    await pending

    const { useInboxStore } = await import('../stores/inbox')
    const inboxStore = useInboxStore()
    inboxStore.setUnreadCount(99)

    sockets[0].onmessage?.({
      target: sockets[0],
      data: JSON.stringify({ type: 'inbox_updated', sessionId: null, data: { unreadCount: 3 } }),
    })

    expect(inboxStore.unreadCount).toBe(3)
  })

  it('onopen 重拉未读数（不进 focusLoaded 分支：未加载聚焦列表时也要更新）', async () => {
    const { useStreamWS } = (await import('./useStreamWS')) as any
    const { connect } = useStreamWS()
    const first = connect()
    sockets[0].open()
    await first

    const { useInboxStore } = await import('../stores/inbox')
    const inboxStore = useInboxStore()
    const spy = vi.spyOn(inboxStore, 'fetchUnreadCount')
    const { useSessionStore } = await import('../stores/session')
    // focusLoaded 保持 false：未读数重拉仍须发生
    expect(useSessionStore().focusLoaded).toBe(false)

    // 断线重连后第二次 onopen
    sockets[0].close()
    await vi.advanceTimersByTimeAsync(1000)
    const second = useStreamWS().connect()
    sockets[1].open()
    await second

    expect(spy).toHaveBeenCalled()
  })
})

describe('useStreamWS session_already_running（拒绝帧不得被 stale 过滤吞掉）', () => {
  it('占用方运行中本端发送被拒时，pendingCallbacks.reject 必须被调用', async () => {
    const { connect, subscribe, setActiveExecution, pendingCallbacks } = useStreamWS()
    const connecting = connect()
    sockets[0].open()
    await connecting
    await subscribe('42')
    // useChat.sendMessage 的真实时序：发送前登记本端新 eventId
    setActiveExecution('42', 'evt-new-1')
    const reject = vi.fn()
    pendingCallbacks.set('42', { resolve: vi.fn(), reject })

    // 后端 sendSessionAlreadyRunning：data.executionId 总是携带占用方的 executionId，
    // 永远不等于本端刚登记的 active id——若按 stale 过滤会把拒绝帧吞掉，发送假成功
    sockets[0].onmessage?.({
      target: sockets[0],
      data: JSON.stringify({
        type: 'session_already_running',
        sessionId: 42,
        data: {
          code: 'session_already_running',
          message: '该任务仍在运行，请先停止当前执行后再继续',
          executionId: 'exec-remote-1',
        },
      }),
    })

    expect(reject).toHaveBeenCalledTimes(1)
    expect(reject.mock.calls[0]?.[0]).toBeInstanceOf(Error)
  })
})

describe('useStreamWS 崩溃恢复 executionId 重绑（恢复帧不得被 stale 过滤吞掉）', () => {
  const frame = (type: string, data: Record<string, unknown>) =>
    sockets[0].onmessage?.({
      target: sockets[0],
      data: JSON.stringify({ type, sessionId: 42, data }),
    })

  it('session_snapshot 带恢复执行的新 executionId 后，流式帧正常进入 store', async () => {
    const { connect, setActiveExecution } = useStreamWS()
    const store = useSessionStore()
    const connecting = connect()
    sockets[0].open()
    await connecting
    // 后端重启前：前端登记的是旧执行的 executionId
    setActiveExecution('42', 'exec-before-restart')
    const shown = () => store.getMessages('42').map((m) => String(m.content)).join('')

    // 崩溃恢复换了新 executionId：重绑前到达的帧仍按陈旧帧丢弃
    frame('content_delta', { delta: '[恢复前帧]', executionId: 'exec-recovered' })
    expect(shown()).not.toContain('[恢复前帧]')

    // 重连 subscribe 的校准快照带上新 executionId → 重绑
    frame('session_snapshot', { phase: 'RUNNING', executionId: 'exec-recovered' })

    // 重绑后恢复执行的流式帧不再被丢弃
    frame('content_delta', { delta: '[恢复执行增量]', executionId: 'exec-recovered' })
    expect(shown()).toContain('[恢复执行增量]')

    // 旧执行的迟到帧仍按陈旧帧丢弃
    frame('content_delta', { delta: '[旧执行迟到帧]', executionId: 'exec-before-restart' })
    expect(shown()).not.toContain('[旧执行迟到帧]')
  })

  it('恢复启动晚于重连时，session_status RUNNING 带新 executionId 同样完成重绑', async () => {
    const { connect, setActiveExecution } = useStreamWS()
    const store = useSessionStore()
    const connecting = connect()
    sockets[0].open()
    await connecting
    setActiveExecution('42', 'exec-before-restart')

    frame('session_status', { phase: 'RUNNING', executionId: 'exec-recovered' })
    frame('content_delta', { delta: '[恢复执行增量2]', executionId: 'exec-recovered' })

    expect(store.getMessages('42').map((m) => String(m.content)).join('')).toContain('[恢复执行增量2]')
  })
})
