import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../utils/auth-storage', () => ({
  getToken: () => 'test-token',
}))
vi.mock('../api', () => ({
  api: { get: vi.fn().mockResolvedValue({ data: [] }) },
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
