import { describe, expect, it } from 'vitest'
import type { ChatMessage, ToolCall } from '../types/chat'
import { discardAbortedStreamTail, mapApiMessagesToChat, extractCitationsFromMetadata, extractResultTruncatedFromMetadata } from './chatMessage'

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

describe('backend truncation in history', () => {
  it('extractResultTruncatedFromMetadata reads top-level flag from string/object metadata', () => {
    expect(extractResultTruncatedFromMetadata('{"resultTruncated":true}')).toBe(true)
    expect(extractResultTruncatedFromMetadata({ resultTruncated: true })).toBe(true)
    expect(extractResultTruncatedFromMetadata('{"resultTruncated":false}')).toBe(false)
    expect(extractResultTruncatedFromMetadata('{"approvalMark":{"mode":"llm"}}')).toBe(false)
    expect(extractResultTruncatedFromMetadata('not json')).toBe(false)
    expect(extractResultTruncatedFromMetadata(null)).toBe(false)
  })

  it('mapApiMessagesToChat marks the matching tool call as truncated', () => {
    const chat = mapApiMessagesToChat([
      { role: 'assistant', content: '', toolCalls: [{ id: 'tc1', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', toolCallId: 'tc1', content: 'big output…', metadata: '{"resultTruncated":true}' },
    ])
    const call = chat.find(c => c.role === 'assistant')?.toolCalls?.find(t => t.id === 'tc1')
    expect(call?.resultTruncated).toBe(true)
  })

  it('mapApiMessagesToChat leaves non-truncated tool calls unset', () => {
    const chat = mapApiMessagesToChat([
      { role: 'assistant', content: '', toolCalls: [{ id: 'tc2', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', toolCallId: 'tc2', content: 'ok', metadata: '{"approvalMark":{"mode":"llm","approved":true,"reason":"x"}}' },
    ])
    const call = chat.find(c => c.role === 'assistant')?.toolCalls?.find(t => t.id === 'tc2')
    expect(call?.resultTruncated).toBeUndefined()
    expect(call?.approvalMark).toEqual({ mode: 'llm', approved: true, reason: 'x' })
  })
})

describe('extractCitationsFromMetadata', () => {
  const meta = (citations: unknown) => JSON.stringify({ citations })

  it('解析 citations 数组并按 n 升序', () => {
    const out = extractCitationsFromMetadata(meta([
      { n: 3, url: 'https://c.example.com', title: 'C' },
      { n: 1, url: 'https://a.example.com', title: 'A' },
    ]))
    expect(out).toEqual([
      { n: 1, url: 'https://a.example.com', title: 'A' },
      { n: 3, url: 'https://c.example.com', title: 'C' },
    ])
  })

  it('去重（同 n 只留首条）', () => {
    const out = extractCitationsFromMetadata(meta([
      { n: 1, url: 'https://a.example.com', title: 'A' },
      { n: 1, url: 'https://dup.example.com', title: 'D' },
    ]))
    expect(out).toHaveLength(1)
    expect(out[0].url).toBe('https://a.example.com')
  })

  it('非法条目跳过：n 非正整数 / url 非 http(s) / 非对象', () => {
    const out = extractCitationsFromMetadata(meta([
      { n: 0, url: 'https://a.example.com' },
      { n: 1.5, url: 'https://a.example.com' },
      { n: 2, url: 'javascript:alert(1)' },
      { n: 3, url: 'https://ok.example.com', title: 42 },
      'not-an-object',
      null,
    ]))
    expect(out).toEqual([{ n: 3, url: 'https://ok.example.com', title: '' }])
  })

  it('metadata 为 null / 空串 / 非法 JSON / 无 citations 键时返回空数组', () => {
    expect(extractCitationsFromMetadata(null)).toEqual([])
    expect(extractCitationsFromMetadata('')).toEqual([])
    expect(extractCitationsFromMetadata('{bad')).toEqual([])
    expect(extractCitationsFromMetadata(JSON.stringify({ resultTruncated: true }))).toEqual([])
  })

  it('metadata 已是对象（非 string）时同样解析', () => {
    const out = extractCitationsFromMetadata({ citations: [{ n: 1, url: 'https://a.example.com', title: 'A' }] })
    expect(out).toEqual([{ n: 1, url: 'https://a.example.com', title: 'A' }])
  })
})
