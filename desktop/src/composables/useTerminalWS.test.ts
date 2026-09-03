import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../utils/auth-storage', () => ({
  getToken: () => 'test-token',
}))

const sockets: FakeWebSocket[] = []

class FakeWebSocket {
  static readonly OPEN = 1
  static readonly CLOSED = 3
  readyState = 0
  onopen: (() => void) | null = null
  onmessage: ((e: { target: unknown; data: string }) => void) | null = null
  onclose: ((e: { target: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  readonly sent: Array<Record<string, any>> = []
  readonly url: string

  constructor(url: string) {
    this.url = url
    sockets.push(this)
  }

  /** 模拟握手完成。 */
  open() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  /** 模拟服务端下发一帧。 */
  emit(payload: Record<string, unknown>) {
    this.onmessage?.({ target: this, data: JSON.stringify(payload) })
  }

  send(data: string) {
    this.sent.push(JSON.parse(data))
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
    this.onclose?.({ target: this })
  }

  frames(type: string): Array<Record<string, any>> {
    return this.sent.filter((f) => f.type === type)
  }
}

;(globalThis as any).WebSocket = FakeWebSocket

const { useTerminalWS } = await import('./useTerminalWS')

/** 建连 + 认证，返回当前 socket。 */
function connectAndAuth(): FakeWebSocket {
  const socket = sockets[sockets.length - 1]
  socket.open()
  socket.emit({ type: 'connected', userId: 1 })
  return socket
}

beforeEach(() => {
  useTerminalWS().disconnect()
  sockets.length = 0
})

describe('useTerminalWS', () => {
  it('先发 auth，收到 connected 后才发 attach', async () => {
    const ws = useTerminalWS()
    const attached = ws.attach('t1')
    const socket = sockets[0]
    socket.open()
    expect(socket.sent.map((f) => f.type)).toEqual(['auth'])

    socket.emit({ type: 'connected', userId: 1 })
    expect(socket.frames('attach')).toEqual([{ type: 'attach', terminalId: 't1' }])

    socket.emit({ type: 'attached', terminalId: 't1', cols: 80, rows: 24 })
    await expect(attached).resolves.toBeUndefined()
  })

  it('disconnect 后重新 attach 仍能建立新连接', async () => {
    const ws = useTerminalWS()
    void ws.attach('t1')
    connectAndAuth()
    expect(sockets).toHaveLength(1)

    ws.disconnect()
    // 登出后重新登录：attach 必须能重新建连，否则终端永久不可用
    const attached = ws.attach('t2')
    expect(sockets).toHaveLength(2)
    const socket = connectAndAuth()
    expect(socket.frames('attach')).toEqual([{ type: 'attach', terminalId: 't2' }])
    socket.emit({ type: 'attached', terminalId: 't2', cols: 80, rows: 24 })
    await expect(attached).resolves.toBeUndefined()
  })

  it('重连后自动重发 attach，且不重复', () => {
    const ws = useTerminalWS()
    void ws.attach('t1')
    const first = connectAndAuth()
    first.close()

    void ws.attach('t1')
    const second = sockets[1]
    second.open()
    second.emit({ type: 'connected', userId: 1 })
    expect(second.frames('attach')).toEqual([{ type: 'attach', terminalId: 't1' }])
  })

  it('已认证后重复收到 connected 不再重发 attach', () => {
    const ws = useTerminalWS()
    void ws.attach('t1')
    const socket = connectAndAuth()
    expect(socket.frames('attach')).toHaveLength(1)

    socket.emit({ type: 'connected', userId: 1 })
    expect(socket.frames('attach')).toHaveLength(1)
  })

  it('detach 后不再发送输入，且会通知服务端解绑', () => {
    const ws = useTerminalWS()
    void ws.attach('t1')
    const socket = connectAndAuth()

    ws.sendInput('t1', 'ls')
    expect(socket.frames('input')).toHaveLength(1)

    ws.detach('t1')
    expect(socket.frames('detach')).toEqual([{ type: 'detach', terminalId: 't1' }])
    expect(ws.isAttached('t1')).toBe(false)
    ws.sendInput('t1', 'pwd')
    expect(socket.frames('input')).toHaveLength(1)
  })

  it('未连接时输入入队，认证后按 attach 优先顺序补发', () => {
    const ws = useTerminalWS()
    void ws.attach('t1')
    ws.sendInput('t1', 'queued')
    const socket = sockets[0]
    expect(socket.sent).toEqual([])

    socket.open()
    socket.emit({ type: 'connected', userId: 1 })
    expect(socket.sent.map((f) => f.type)).toEqual(['auth', 'attach', 'input'])
  })

  it('服务端错误帧会让 attach 结束等待并停止自动重连该终端', async () => {
    const ws = useTerminalWS()
    const errors: string[] = []
    ws.registerTerminal('t1', {
      onOutput: () => {},
      onError: (code) => errors.push(code),
    })
    const attached = ws.attach('t1')
    const socket = connectAndAuth()
    socket.emit({ type: 'error', terminalId: 't1', code: 'TERMINAL_RECLAIMED', message: '已回收' })

    await expect(attached).resolves.toBeUndefined()
    expect(errors).toEqual(['TERMINAL_RECLAIMED'])
    expect(ws.isAttached('t1')).toBe(false)
  })
})
