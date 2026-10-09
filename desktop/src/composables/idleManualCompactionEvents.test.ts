import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// 回归：空闲手动压缩（compact_now 空闲路径）的合成 listener 事件不得被前端陈旧执行帧门吞掉。
// 场景：同一 WS 连接内先正常跑完一轮任务（session_status RUNNING→COMPLETED 触发 clearActiveExecution
// 把该会话加入 suppressedStreamSessions），随后空闲态点击「立即整理上下文」。后端合成 listener 以
// executionId=manual_compact_<ts> 下发 compaction_* / context_window，该 id 不经 RUNNING 帧登记；
// 若陈旧帧门不豁免 sentinel id，过程事件会被整批丢弃（违反技术方案 §11.3 的「过程实时可见 / 水位下降 /
// 分隔线 / isCompacting 点亮」验收）。
// 来源：docs/plan/2026-10-06-context-inspector-technical-design.md 决策 11 / 验收 3。

vi.mock('../utils/auth-storage', () => ({ getToken: () => 'test-token' }))
vi.mock('element-plus', () => ({
  ElMessage: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
}))
vi.mock('../api', () => ({
  api: { get: vi.fn().mockResolvedValue({ data: [] }) },
  fetchInboxUnreadCount: vi.fn().mockResolvedValue({ unreadCount: 0 }),
  fetchInboxList: vi.fn().mockResolvedValue({ records: [], total: 0, page: 1, size: 20 }),
  markInboxItemRead: vi.fn(),
  markInboxAllRead: vi.fn(),
  removeInboxItem: vi.fn(),
  getInboxPreference: vi.fn().mockResolvedValue({
    taskCompletedEnabled: true, questionPendingEnabled: true, approvalPendingEnabled: true,
    subagentDoneEnabled: false, openApiCallFailedEnabled: false, systemNotifyEnabled: true,
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
  constructor(url: string) { this.url = url; sockets.push(this) }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.() }
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close() { this.readyState = FakeWebSocket.CLOSED; this.onclose?.({ target: this }) }
}
;(globalThis as any).WebSocket = FakeWebSocket

class WindowEventTarget extends EventTarget {}
Object.defineProperty(globalThis, 'window', {
  value: new WindowEventTarget(), writable: true, configurable: true,
})

const { useStreamWS } = await import('./useStreamWS')
const { useSessionStore } = await import('../stores/session')
const { ElMessage } = await import('element-plus')

beforeEach(() => {
  setActivePinia(createPinia())
  useStreamWS().disconnect()
  sockets.length = 0
})
afterEach(() => {
  useStreamWS().disconnect()
  sockets.length = 0
})

describe('空闲手动压缩的合成事件不被陈旧执行帧门丢弃', () => {
  const frame = (type: string, data: Record<string, unknown>) =>
    sockets[0].onmessage?.({ target: sockets[0], data: JSON.stringify({ type, sessionId: 42, data }) })

  it('上一轮 COMPLETED 后空闲手动压缩的 compaction_start 驱动「正在整理」态', async () => {
    const { connect, subscribe } = useStreamWS()
    const store = useSessionStore()
    const connecting = connect()
    sockets[0].open()
    await connecting
    await subscribe('42')

    // 正常跑一轮：RUNNING 登记 active，COMPLETED 终态 → clearActiveExecution（会话进入 suppressed）
    frame('session_status', { phase: 'RUNNING', executionId: 'exec-run-1' })
    frame('session_status', { phase: 'COMPLETED', executionId: 'exec-run-1' })
    expect(store.isSessionCompacting('42')).toBe(false)

    // 空闲态点击「立即整理上下文」：合成 listener 以新的 manual_compact_* 下发（无 RUNNING 登记）
    frame('compaction_start', { type: 'manual', messageCount: 30, estimatedTokens: 4000, executionId: 'manual_compact_123' })

    // 手动压缩过程事件实时可见，正在整理态被点亮
    expect(store.isSessionCompacting('42')).toBe(true)
  })

  it('上一轮 COMPLETED 后手动压缩的 context_window 刷新水位', async () => {
    const { connect, subscribe } = useStreamWS()
    const store = useSessionStore()
    const connecting = connect()
    sockets[0].open()
    await connecting
    await subscribe('42')
    frame('session_status', { phase: 'RUNNING', executionId: 'exec-run-1' })
    frame('session_status', { phase: 'COMPLETED', executionId: 'exec-run-1' })
    frame('context_window', { estimated: 1234, actual: 0, executionId: 'manual_compact_123' })
    expect(store.getContextWindow('42')?.estimated).toBe(1234)
  })

  it('上一轮 COMPLETED 后手动压缩的 compaction_marker 落到消息区分隔线', async () => {
    const { connect, subscribe } = useStreamWS()
    const store = useSessionStore()
    const connecting = connect()
    sockets[0].open()
    await connecting
    await subscribe('42')
    frame('session_status', { phase: 'RUNNING', executionId: 'exec-run-1' })
    frame('session_status', { phase: 'COMPLETED', executionId: 'exec-run-1' })
    frame('compaction_marker', {
      id: 900, triggerMode: 'manual', prevBoundaryMsgId: 0, boundaryMsgId: 55,
      compactedMessageCount: 30, summaryTokens: 120, savedTokens: 3800, durationMs: 1500,
      executionId: 'manual_compact_123',
    })
    const events = store.getCompactionEvents('42')
    expect(events.some(e => e.id === '900' && e.triggerMode === 'manual')).toBe(true)
    // 过程结束回落非整理态
    frame('compaction_end', { type: 'manual', summaryTokens: 120, savedTokens: 3800, durationMs: 1500, executionId: 'manual_compact_123' })
    expect(store.isSessionCompacting('42')).toBe(false)
  })

  it('对照：真实执行的迟到残留（非 sentinel）仍被 suppressed 门丢弃', async () => {
    const { connect, subscribe } = useStreamWS()
    const store = useSessionStore()
    const connecting = connect()
    sockets[0].open()
    await connecting
    await subscribe('42')
    frame('session_status', { phase: 'RUNNING', executionId: 'exec-run-1' })
    frame('session_status', { phase: 'COMPLETED', executionId: 'exec-run-1' })
    // 已取消/完成执行的残留 content_delta（旧 id，非 sentinel）：不得点亮正在整理态、不得改水位
    frame('content_delta', { delta: 'straggler', executionId: 'exec-run-1' })
    frame('context_window', { estimated: 9999, actual: 0, executionId: 'exec-run-1' })
    expect(store.getContextWindow('42')?.estimated).not.toBe(9999)
  })

  it('手动整理失败的 compaction_result 回执只提示、不把会话标成执行 FAILED', async () => {
    const { connect, subscribe } = useStreamWS()
    const store = useSessionStore()
    const connecting = connect()
    sockets[0].open()
    await connecting
    await subscribe('42')
    frame('session_status', { phase: 'RUNNING', executionId: 'exec-run-1' })
    frame('session_status', { phase: 'COMPLETED', executionId: 'exec-run-1' })
    // 空闲手动压缩失败：后端经压缩通道回传 compaction_result{failed:true}（绝非通用 error 事件），
    // 因此会话执行状态保持 COMPLETED，不被误标 FAILED；只弹一条维护失败提示。
    frame('compaction_result', { compacted: false, failed: true, message: '模型整理失败', executionId: 'manual_compact_99' })
    expect(store.getSessionPhase('42')).not.toBe('FAILED')
    expect(ElMessage.error).toHaveBeenCalledWith('模型整理失败')
  })
})
