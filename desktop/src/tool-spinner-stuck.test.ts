import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionStore } from './stores/session'
import { mapMessagesWithFileChanges } from './utils/chatMessage'

vi.mock('./api', () => ({ api: { get: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn(), post: vi.fn() } }))

/**
 * 模拟 useChat.fetchMessages 的核心逻辑（与 desktop/src/composables/useChat.ts 一致）：
 * REST 历史覆盖缓存，preserveLiveStream 时保留 tracked 流式气泡。
 */
function simulateFetchMessages(store: ReturnType<typeof useSessionStore>, sid: string, rawApiMessages: Array<Record<string, unknown>>, options?: { preserveLiveStream?: boolean }) {
  const { messages } = mapMessagesWithFileChanges(rawApiMessages)
  store.applyFetchedMessages(sid, messages, {
    preserveStreamingAssistant: Boolean(options?.preserveLiveStream),
  })
}

/** 模拟 useStreamWS routeEvent 中的工具事件处理 */
function onToolCallStart(store: ReturnType<typeof useSessionStore>, sid: string, data: { tool_call_id: string; tool_name: string; arguments?: string }) {
  store.setStreaming(sid, false)
  store.appendToolCallStart(sid, data)
}
function onToolCallResult(store: ReturnType<typeof useSessionStore>, sid: string, data: { tool_call_id: string; tool_name?: string; result: string; status?: string; summary?: string }) {
  store.updateToolCallResult(sid, data)
}

function apiAssistantRound(id: string, text: string, toolCalls: Array<{ id: string; name: string; args: string }>, toolResults: Record<string, string>) {
  const msgs: Array<Record<string, unknown>> = [
    { id, role: 'assistant', content: text, createdAt: '2026-08-28T10:00:00', toolCalls: toolCalls.map(t => ({ id: t.id, name: t.name, arguments: t.args })) },
  ]
  for (const t of toolCalls) {
    if (t.id in toolResults) {
      msgs.push({ id: `${id}-tool-${t.id}`, role: 'tool', toolCallId: t.id, content: toolResults[t.id] })
    }
  }
  return msgs
}

describe('工具调用转圈永久残留回归', () => {
  let store: ReturnType<typeof useSessionStore>
  beforeEach(() => {
    setActivePinia(createPinia())
    store = useSessionStore()
  })

  it('场景B回归：首开运行中会话（subscribe replay 先于 fetch），REST 覆盖后结果事件仍落到 tracked 气泡，且不再产生等不到结果的幻影副本', () => {
    const sid = 'a2'
    // 1) WS subscribe replay：三个 active 工具 → 创建 tracked 气泡
    onToolCallStart(store, sid, { tool_call_id: 't1', tool_name: 'shell', arguments: '{"command":"a"}' })
    onToolCallStart(store, sid, { tool_call_id: 't2', tool_name: 'shell', arguments: '{"command":"b"}' })
    onToolCallStart(store, sid, { tool_call_id: 't3', tool_name: 'shell', arguments: '{"command":"c"}' })
    // 2) REST 历史返回（当前轮未持久化，最后一条 assistant 是上一轮），保留 tracked 气泡
    const history = apiAssistantRound('prev', '上一轮', [{ id: 'p1', name: 'shell', args: '{"command":"p"}' }], { p1: '{}' })
    simulateFetchMessages(store, sid, history, { preserveLiveStream: true })
    // 3) 结果事件到达
    onToolCallResult(store, sid, { tool_call_id: 't1', result: '{}', status: 'success' })
    onToolCallResult(store, sid, { tool_call_id: 't2', result: '{}', status: 'success' })
    onToolCallResult(store, sid, { tool_call_id: 't3', result: '{}', status: 'success' })

    const msgs = store.getMessages(sid)
    // 上一轮 assistant 不被合并进运行中工具副本（旧实现会产生永远 running 的幻影）
    const prevBubble = msgs.find(m => m.id === 'prev')!
    expect(prevBubble.toolCalls?.map(c => c.id)).toEqual(['p1'])
    // tracked 气泡内的工具全部终结
    const stuck = msgs.flatMap(m => m.toolCalls || []).filter(c => c.status === 'running')
    expect(stuck).toHaveLength(0)
  })

  it('场景D回归：CANCELLED 终态就地终结仍在 running 的工具（服务端不会为被中止轮次补发结果）', () => {
    const sid = 'a4'
    store.addUserMessage(sid, { id: 'u1', role: 'user', content: '跑测试', createdAt: 'x' })
    onToolCallStart(store, sid, { tool_call_id: 't1', tool_name: 'shell', arguments: '{"command":"a"}' })
    onToolCallStart(store, sid, { tool_call_id: 't2', tool_name: 'shell', arguments: '{"command":"b"}' })
    onToolCallStart(store, sid, { tool_call_id: 't3', tool_name: 'shell', arguments: '{"command":"c"}' })
    onToolCallResult(store, sid, { tool_call_id: 't1', result: '{}', status: 'success', summary: '执行 a' })
    onToolCallResult(store, sid, { tool_call_id: 't2', result: '{}', status: 'success', summary: '执行 b' })
    // t3 执行期间执行被中止：t3 永远等不到结果事件

    store.finishInterruptedStreamingMessage(sid, '执行已被中止')

    const calls = store.getMessages(sid).flatMap(m => m.toolCalls || [])
    expect(calls.map(c => c.status)).toEqual(['success', 'success', 'error'])
    expect(calls[2].summary).toBe('执行已被中止')
    // tracked 气泡已终结，后续新一轮执行的事件会落到新气泡，不再续接到带残留的旧气泡
  })

  it('场景D补充：FAILED 终态同样终结 running 工具', () => {
    const sid = 'a5'
    onToolCallStart(store, sid, { tool_call_id: 't1', tool_name: 'shell', arguments: '{}' })
    store.finishInterruptedStreamingMessage(sid, '执行失败中断')
    expect(store.getMessages(sid).flatMap(m => m.toolCalls || [])[0].status).toBe('error')
  })
})
