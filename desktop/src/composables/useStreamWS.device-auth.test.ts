import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('../utils/auth-storage', () => ({
  getToken: () => 'test-token',
}))
vi.mock('../api', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: [] }),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
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
    budgetWarnEnabled: true,
    openApiCallFailedEnabled: false,
    systemNotifyEnabled: true,
  }),
  saveInboxPreference: vi.fn(),
}))
vi.mock('../utils/localSkills', () => ({ collectLocalUnsyncedSkills: vi.fn(async () => []) }))
vi.mock('../utils/agentsMd', () => ({ collectAgentsMdContent: vi.fn(async () => undefined) }))

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
  autoAck = true

  constructor(url: string) {
    this.url = url
    sockets.push(this)
  }

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
    if (this.autoAck) this.message({ type: 'connected', data: { userId: 7 } })
  }

  message(payload: Record<string, unknown>) {
    this.onmessage?.({ target: this, data: JSON.stringify(payload) })
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

// Electron 形态：window.electronAPI 注入 getDeviceInfo（其余桥接方法缺省时空转）
const getDeviceInfo = vi.fn(async () => ({ id: 'dev-electron', name: 'Mac A', platform: 'darwin' }))
const windowStub = new EventTarget() as unknown as Record<string, unknown>
windowStub.electronAPI = { getDeviceInfo }
Object.defineProperty(globalThis, 'window', {
  value: windowStub, writable: true, configurable: true,
})

const { useStreamWS } = await import('./useStreamWS')

beforeEach(() => {
  setActivePinia(createPinia())
  sockets.length = 0
})

afterEach(() => {
  useStreamWS().disconnect()
  sockets.length = 0
})

// 技术方案 2026-11-05 §4.2：Electron 首帧 auth 携带本机设备身份，服务端据此登记可定向投递的执行连接
describe('useStreamWS Electron auth device', () => {
  it('sends device identity in the first auth frame', async () => {
    const { connect } = useStreamWS()
    const pending = connect()
    sockets[0].open()
    await pending
    await new Promise((r) => setTimeout(r, 0))

    expect(getDeviceInfo).toHaveBeenCalled()
    const auth = sockets[0].sent.find((m) => m.type === 'auth')
    expect(auth).toBeDefined()
    expect(auth).toMatchObject({
      client: 'electron',
      device: { id: 'dev-electron', name: 'Mac A', platform: 'darwin' },
    })
    // 首帧必须是 auth：设备身份在 IPC 异步返回后才发，期间不得有业务帧抢先
    expect(sockets[0].sent[0]?.type).toBe('auth')
  })
})
