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
