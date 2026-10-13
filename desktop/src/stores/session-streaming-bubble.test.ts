import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useSessionStore } from './session'

vi.mock('../api', () => ({
  api: {
    get: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    post: vi.fn(),
  },
}))

/**
 * 逻辑回归用例（round2 审查修复后转正）：
 * 1. 边路任务首发：占位 key → 真实 sid 迁移用 setMessages + clearMessages 整体搬运，
 *    两个 action 都会删掉 streamingAssistantMessageIds 注册，导致首个 content_delta
 *    重新建一个 assistant 气泡——同一轮流式回复被劈成「空白气泡 + 新气泡」。
 * 2. 文本流式中点「停止」：finishInterruptedStreamingMessage 删注册后，终态重拉
 *    （不传 preserveLiveStream）把未落库的部分回复气泡整体丢弃，内容永久丢失。
 */

describe('桌面消息 store 流式气泡生命周期', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('边路会话占位→转正迁移后，流式气泡必须被复用而不是新建', () => {
    const store = useSessionStore()
    // 首发：占位 key 下乐观用户消息 + 流式占位气泡（SideChatPanel.vue:964-971）
    store.addUserMessage('tab-7', {
      id: 'side_user_1', role: 'user', content: '帮我审查', createdAt: '2026-10-12 10:00:00',
    })
    const bubble = store.ensureStreamingAssistantMessage('tab-7')
    expect(store.getMessages('tab-7')).toHaveLength(2)

    // side_session_created → watcher 迁移（SideChatPanel.vue:529-533）
    const tempMsgs = store.getMessages('tab-7')
    store.setMessages('42', [...tempMsgs])
    store.clearMessages('tab-7')

    // user_message_saved 替换乐观 ID（useStreamWS.ts:877-878）
    store.updateLastMessageId('42', 'user', '501')

    // 首个 content_delta
    store.appendDelta('42', '第一段回复')

    const msgs = store.getMessages('42')
    // 期望：['user','assistant'] 且复用迁移来的气泡。当前实际：['user','assistant','assistant']
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1].id).toBe(bubble.id)
    expect(msgs[1].content).toContain('第一段回复')
  })

  it('CANCELLED 终态重拉不丢弃已流式输出的部分回复（服务端不落库被中止轮次）', () => {
    const store = useSessionStore()
    store.setMessages('9', [{
      id: '100', role: 'user', content: '写个快排', createdAt: '2026-10-12 10:00:00',
    }])
    store.ensureStreamingAssistantMessage('9')
    store.appendDelta('9', '好的，这是快速排序实现：')

    // 服务端确认 CANCELLED（useStreamWS.ts:705）
    store.finishInterruptedStreamingMessage('9', '执行已被中止')

    // 终态重拉（useChat.ts:833 未传 preserveLiveStream）；被中止轮次 REST 不返回 assistant
    store.applyFetchedMessages('9', [
      { id: '100', role: 'user', content: '写个快排', createdAt: '2026-10-12 10:00:00' },
    ])

    const msgs = store.getMessages('9')
    // 期望：['user','assistant'] 部分回复保留可见。当前实际：['user']
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1].content).toContain('快速排序')
  })

  it('对照组：正常完成后终态重拉按 REST 覆盖（现有行为不回退）', () => {
    const store = useSessionStore()
    store.setMessages('8', [{
      id: '200', role: 'user', content: '你好', createdAt: '2026-10-12 10:00:00',
    }])
    const bubble = store.ensureStreamingAssistantMessage('8')
    store.appendDelta('8', '完整回复')
    // 正常完成：markMessageComplete 清注册，REST 已含该 assistant
    store.markMessageComplete('8', { total_tokens: 10 })
    store.applyFetchedMessages('8', [
      { id: '200', role: 'user', content: '你好', createdAt: '2026-10-12 10:00:00' },
      { id: '201', role: 'assistant', content: '完整回复', createdAt: '2026-10-12 10:00:01' },
    ])
    const msgs = store.getMessages('8')
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1].id).toBe('201')
    expect(bubble.content).toContain('完整回复')
  })

  // round 1 BUG-1 修复的竞态面：停止点击与服务端落库/完成广播竞态时，这一轮其实
  // 已持久化（REST 该用户消息之后的第一条助手消息正是同一回复）。中断气泡若一并
  // 保留，对话区出现「部分回复 + 完整回复」两条相同内容的气泡。
  it('同轮已落库时中断气泡是本地回显，不重复保留', () => {
    const store = useSessionStore()
    store.setMessages('9', [{
      id: '100', role: 'user', content: '写个快排', createdAt: '2026-10-12 10:00:00',
    }])
    store.ensureStreamingAssistantMessage('9')
    store.appendDelta('9', '好的，这是快速排序实现：')
    store.finishInterruptedStreamingMessage('9', '执行已被中止')

    // 停止竞态：REST 里这一轮已落库（id 201）
    store.applyFetchedMessages('9', [
      { id: '100', role: 'user', content: '写个快排', createdAt: '2026-10-12 10:00:00' },
      { id: '201', role: 'assistant', content: '好的，这是快速排序实现：', createdAt: '2026-10-12 10:00:05' },
    ])

    const msgs = store.getMessages('9')
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(msgs[1].id).toBe('201')
    expect(msgs.filter((m) => m.role === 'assistant')).toHaveLength(1)
  })

  it('下一轮完成后再重拉，中止轮次的气泡按原位置插回、不重复', () => {
    const store = useSessionStore()
    store.setMessages('9', [{
      id: '100', role: 'user', content: '写个快排', createdAt: '2026-10-12 10:00:00',
    }])
    store.ensureStreamingAssistantMessage('9')
    store.appendDelta('9', '半段回复')
    store.finishInterruptedStreamingMessage('9', '执行已被中止')
    // 用户又发了一轮：乐观用户消息落库后 user_message_saved 换成本身 id
    store.addUserMessage('9', {
      id: 'msg_2_user', role: 'user', content: '再写个归并', createdAt: '2026-10-12 10:01:00',
    })
    store.updateLastMessageId('9', 'user', '101')
    store.ensureStreamingAssistantMessage('9')
    store.appendDelta('9', '归并排序实现')
    store.markMessageComplete('9', { total_tokens: 10 })

    // REST：第一轮未落库（无 assistant），第二轮已落库
    store.applyFetchedMessages('9', [
      { id: '100', role: 'user', content: '写个快排', createdAt: '2026-10-12 10:00:00' },
      { id: '101', role: 'user', content: '再写个归并', createdAt: '2026-10-12 10:01:00' },
      { id: '202', role: 'assistant', content: '归并排序实现', createdAt: '2026-10-12 10:01:05' },
    ])

    const msgs = store.getMessages('9')
    // 半段回复插回第一轮之后、第二轮之前，位置与内容都不丢
    expect(msgs.map((m) => m.content)).toEqual([
      '写个快排', '半段回复', '再写个归并', '归并排序实现',
    ])
  })
})
