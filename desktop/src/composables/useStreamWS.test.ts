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
