import { describe, expect, it } from 'vitest'
import type { ChatMessage, ToolCall } from '../types/chat'
import { discardAbortedStreamTail } from './chatMessage'

function tool(id: string, status: ToolCall['status']): ToolCall {
  return { id, name: 'shell', status, isExpanded: false, argsStreaming: false }
}

function msg(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'a1',
    role: 'assistant',
    content: '',
    createdAt: '2026-09-08 12:00:00',
    toolCalls: [],
    segments: [],
    ...overrides,
  }
}

describe('discardAbortedStreamTail', () => {
  it('没有已完成工具时清空整条气泡', () => {
    const m = msg({
      content: '部分输出',
      thinkingContent: '思考中',
      toolCalls: [tool('t1', 'running')],
      segments: [
        { type: 'thinking', content: '思考中' },
        { type: 'text', content: '部分输出' },
        { type: 'tool', callId: 't1' },
      ],
    })
    discardAbortedStreamTail(m)
    expect(m.content).toBe('')
    expect(m.thinkingContent).toBeUndefined()
    expect(m.toolCalls).toEqual([])
    expect(m.segments).toEqual([])
  })

  it('保留已完成工具及其之前的正文/思考，丢掉未完成尾巴', () => {
    const t1 = tool('t1', 'success')
    t1.summary = '执行 ls'
    const m = msg({
      content: '先检查接着安装部分输出',
      thinkingContent: '上一轮思考中途思考',
      toolCalls: [t1, tool('t2', 'running')],
      segments: [
        { type: 'thinking', content: '上一轮思考' },
        { type: 'text', content: '先检查' },
        { type: 'tool', callId: 't1' },
        { type: 'text', content: '接着安装' },
        { type: 'thinking', content: '中途思考' },
        { type: 'text', content: '部分输出' },
        { type: 'tool', callId: 't2' },
      ],
    })
    discardAbortedStreamTail(m)
    expect(m.toolCalls).toEqual([t1])
    expect(m.segments).toEqual([
      { type: 'thinking', content: '上一轮思考' },
      { type: 'text', content: '先检查' },
      { type: 'tool', callId: 't1' },
    ])
    expect(m.content).toBe('先检查')
    expect(m.thinkingContent).toBe('上一轮思考')
  })

  it('同一轮并行工具只留下已结束的，并从该组截断后续正文', () => {
    const t1 = tool('t1', 'success')
    const t2 = tool('t2', 'error')
    const m = msg({
      content: '查一下然后继续',
      toolCalls: [t1, t2, tool('t3', 'pending')],
      segments: [
        { type: 'text', content: '查一下' },
        { type: 'tool', callId: 't1' },
        { type: 'tool', callId: 't2' },
        { type: 'tool', callId: 't3' },
        { type: 'text', content: '然后继续' },
      ],
    })
    discardAbortedStreamTail(m)
    expect(m.toolCalls?.map(tc => tc.id)).toEqual(['t1', 't2'])
    expect(m.segments).toEqual([
      { type: 'text', content: '查一下' },
      { type: 'tool', callId: 't1' },
      { type: 'tool', callId: 't2' },
    ])
    expect(m.content).toBe('查一下')
  })
})
