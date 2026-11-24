// round.deliveries 收集（统一发送媒体方案 2026-11-18 D6/§7.1；活引用 2026-11-20 §5.2）：按调用顺序收
// send_image / send_file 结果 JSON 里的 delivery；非目标工具、无结果、解析失败、
// delivery 既无 url 又无 ref 一律不收。
import { describe, expect, it } from 'vitest'
import { collectRoundDeliveries, useMessageRounds } from './useMessageRounds'
import type { ChatMessage } from '../types/chat'
import { ref } from 'vue'

function msg(id: string, role: ChatMessage['role'], extra: Partial<ChatMessage> = {}): ChatMessage {
  return { id, role, content: '', createdAt: '2026-11-19T10:00:00', ...extra }
}

function sendToolCall(id: string, name: string, result: unknown) {
  return {
    id,
    name,
    input: { image: 'a.png' },
    status: 'success' as const,
    isExpanded: false,
    argsStreaming: false,
    result: typeof result === 'string' ? result : JSON.stringify(result),
  }
}

describe('collectRoundDeliveries', () => {
  it('按调用顺序收 delivery（kind/url/mime/bytes/filename）', () => {
    const messages = [
      msg('s1', 'assistant', {
        toolCalls: [
          sendToolCall('t1', 'send_image', { success: true, channel: 'feishu', channelStatus: 'sent', filename: 'a.png', delivery: { kind: 'image', url: 'https://h/uploads/7/send-1.png', mime: 'image/png', bytes: 123 } }),
          sendToolCall('t2', 'send_file', { success: true, channel: 'chat', channelStatus: 'skipped', filename: 'r.pdf', delivery: { kind: 'file', url: 'https://h/uploads/7/send-2.pdf', mime: 'application/pdf', bytes: 456 } }),
        ],
      }),
    ]
    expect(collectRoundDeliveries(messages)).toEqual([
      { kind: 'image', url: 'https://h/uploads/7/send-1.png', mime: 'image/png', bytes: 123, filename: 'a.png' },
      { kind: 'file', url: 'https://h/uploads/7/send-2.pdf', mime: 'application/pdf', bytes: 456, filename: 'r.pdf' },
    ])
  })

  it('非目标工具 / 无结果 / 解析失败 / 无 delivery.url 不收', () => {
    const messages = [
      msg('s1', 'assistant', {
        toolCalls: [
          sendToolCall('t1', 'read_file', { content: 'x' }),
          sendToolCall('t2', 'send_image', 'not json'),
          sendToolCall('t3', 'send_file', { success: true, filename: 'x.bin' }),
          sendToolCall('t4', 'send_image', { delivery: { kind: 'image', mime: 'image/png' } }),
        ],
      }),
    ]
    expect(collectRoundDeliveries(messages)).toEqual([])
  })

  it('副本失败（无 delivery）不收；通道结果字段齐全但无 url 也不收', () => {
    const messages = [
      msg('s1', 'assistant', {
        toolCalls: [
          sendToolCall('t1', 'send_image', { success: true, channel: 'feishu', channelStatus: 'sent', error: '已发到飞书，对话页保存失败：附件写入失败' }),
        ],
      }),
    ]
    expect(collectRoundDeliveries(messages)).toEqual([])
  })

  it('filename 缺失回落 URL 尾段', () => {
    const messages = [
      msg('s1', 'assistant', {
        toolCalls: [
          sendToolCall('t1', 'send_file', { success: true, channel: 'chat', channelStatus: 'skipped', delivery: { kind: 'file', url: 'https://h/uploads/7/send-abc.bin' } }),
        ],
      }),
    ]
    expect(collectRoundDeliveries(messages)).toEqual([
      { kind: 'file', url: 'https://h/uploads/7/send-abc.bin', mime: undefined, bytes: undefined, filename: 'send-abc.bin' },
    ])
  })

  it('活引用形态 A：ref 形态照常收集，无 url', () => {
    const messages = [
      msg('s1', 'assistant', {
        toolCalls: [
          sendToolCall('t1', 'send_image', { success: true, channel: 'chat', channelStatus: 'skipped', filename: 'a.png', delivery: { kind: 'image', filename: 'a.png', mime: 'image/png', bytes: 12, ref: { type: 'workspace', sessionId: 42, path: 'reports/a.png' } } }),
        ],
      }),
    ]
    expect(collectRoundDeliveries(messages)).toEqual([
      { kind: 'image', ref: { type: 'workspace', sessionId: 42, path: 'reports/a.png' }, mime: 'image/png', bytes: 12, filename: 'a.png' },
    ])
  })

  it('活引用形态 A：ref 字段残缺（type/path/sessionId 不齐）不收', () => {
    const messages = [
      msg('s1', 'assistant', {
        toolCalls: [
          sendToolCall('t1', 'send_image', { delivery: { kind: 'image', ref: { type: 'workspace', sessionId: 42 } } }),
          sendToolCall('t2', 'send_image', { delivery: { kind: 'image', ref: { type: 'workspace', path: 'a.png' } } }),
          sendToolCall('t3', 'send_image', { delivery: { kind: 'image', ref: { type: 'other', sessionId: 42, path: 'a.png' } } }),
        ],
      }),
    ]
    expect(collectRoundDeliveries(messages)).toEqual([])
  })

  it('活引用形态 A：filename 与 delivery.filename 都缺失时回落 ref.path basename', () => {
    const messages = [
      msg('s1', 'assistant', {
        toolCalls: [
          sendToolCall('t1', 'send_file', { success: true, delivery: { kind: 'file', mime: 'application/pdf', ref: { type: 'workspace', sessionId: 42, path: 'docs/报告.pdf' } } }),
        ],
      }),
    ]
    expect(collectRoundDeliveries(messages)).toEqual([
      { kind: 'file', ref: { type: 'workspace', sessionId: 42, path: 'docs/报告.pdf' }, mime: 'application/pdf', bytes: undefined, filename: '报告.pdf' },
    ])
  })
})

describe('useMessageRounds：round.deliveries 汇总（步骤 + 最终回复）', () => {
  it('跨步骤与最终回复的工具调用都收，随消息更新响应', () => {
    const messages = ref<ChatMessage[]>([
      msg('u1', 'user', { content: '发两张图' }),
      msg('s1', 'assistant', {
        toolCalls: [sendToolCall('t1', 'send_image', { success: true, delivery: { kind: 'image', url: 'https://h/uploads/7/send-1.png' } })],
      }),
      msg('r1', 'assistant', {
        content: '已发送',
        toolCalls: [sendToolCall('t2', 'send_image', { success: true, delivery: { kind: 'image', url: 'https://h/uploads/7/send-2.png' } })],
      }),
    ])
    const { messageRounds } = useMessageRounds(messages, ref(false))
    expect(messageRounds.value).toHaveLength(1)
    expect(messageRounds.value[0]!.deliveries.map(d => d.url)).toEqual([
      'https://h/uploads/7/send-1.png',
      'https://h/uploads/7/send-2.png',
    ])
  })

  it('执行中的轮次随 tool_call_result 实时汇总（§7.1，尚在 sending 时也画）', () => {
    const messages = ref<ChatMessage[]>([
      msg('u1', 'user', { content: '发图' }),
      msg('s1', 'assistant', {
        toolCalls: [sendToolCall('t1', 'send_image', { success: true, delivery: { kind: 'image', url: 'https://h/uploads/7/send-1.png' } })],
      }),
    ])
    const { activeRound, historyRounds } = useMessageRounds(messages, ref(true))
    expect(historyRounds.value).toEqual([])
    expect(activeRound.value?.deliveries.map(d => d.url)).toEqual(['https://h/uploads/7/send-1.png'])
  })
})

// 2026-11-24-send-file-snapshot：快照 ref（send-file）。存量 workspace ref 仍由前端渲染，
// 新发送只写 send-file；parseDeliveryRef 不认识 send-file 会让新卡片整条不渲染。
describe('collectRoundDeliveries：send-file 快照 ref', () => {
  it('按快照 id 收集，无 url', () => {
    const messages = [
      msg('s1', 'assistant', {
        toolCalls: [
          sendToolCall('t1', 'send_image', { success: true, channel: 'chat', channelStatus: 'skipped', filename: 'a.png', delivery: { kind: 'image', filename: 'a.png', mime: 'image/png', bytes: 12, ref: { type: 'send-file', id: 'id-1' } } }),
          sendToolCall('t2', 'send_file', { success: true, channel: 'chat', channelStatus: 'skipped', filename: 'r.pdf', delivery: { kind: 'file', mime: 'application/pdf', ref: { type: 'send-file', id: 'id-2' } } }),
        ],
      }),
    ]
    expect(collectRoundDeliveries(messages)).toEqual([
      { kind: 'image', ref: { type: 'send-file', id: 'id-1' }, mime: 'image/png', bytes: 12, filename: 'a.png' },
      { kind: 'file', ref: { type: 'send-file', id: 'id-2' }, mime: 'application/pdf', bytes: undefined, filename: 'r.pdf' },
    ])
  })

  it('filename 缺失时回落结果级 / delivery 级，再回落 attachment（不再取路径尾段）', () => {
    const messages = [
      msg('s1', 'assistant', {
        toolCalls: [
          sendToolCall('t1', 'send_file', { success: true, delivery: { kind: 'file', mime: 'application/pdf', ref: { type: 'send-file', id: 'id-3' } } }),
          sendToolCall('t2', 'send_file', { success: true, filename: '显式名.pdf', delivery: { kind: 'file', ref: { type: 'send-file', id: 'id-4' } } }),
          sendToolCall('t3', 'send_file', { success: true, delivery: { kind: 'file', filename: 'delivery 级.pdf', ref: { type: 'send-file', id: 'id-5' } } }),
        ],
      }),
    ]
    expect(collectRoundDeliveries(messages).map(d => d.filename)).toEqual(['attachment', '显式名.pdf', 'delivery 级.pdf'])
  })

  it('send-file ref 残缺（缺 id / 空串 / 未知 type）不收', () => {
    const messages = [
      msg('s1', 'assistant', {
        toolCalls: [
          sendToolCall('t1', 'send_image', { delivery: { kind: 'image', ref: { type: 'send-file' } } }),
          sendToolCall('t2', 'send_image', { delivery: { kind: 'image', ref: { type: 'send-file', id: '' } } }),
          sendToolCall('t3', 'send_image', { delivery: { kind: 'image', ref: { type: 'other', id: 'x' } } }),
        ],
      }),
    ]
    expect(collectRoundDeliveries(messages)).toEqual([])
  })

  it('存量 workspace ref 与快照 ref 可在同一轮共存（各自 key 不同）', () => {
    const messages = [
      msg('s1', 'assistant', {
        toolCalls: [
          sendToolCall('t1', 'send_image', { success: true, delivery: { kind: 'image', mime: 'image/png', ref: { type: 'workspace', sessionId: 42, path: 'a.png' } } }),
          sendToolCall('t2', 'send_image', { success: true, delivery: { kind: 'image', mime: 'image/png', ref: { type: 'send-file', id: 'id-9' } } }),
        ],
      }),
    ]
    const deliveries = collectRoundDeliveries(messages)
    expect(deliveries).toHaveLength(2)
    expect(deliveries[0]!.ref).toEqual({ type: 'workspace', sessionId: 42, path: 'a.png' })
    expect(deliveries[1]!.ref).toEqual({ type: 'send-file', id: 'id-9' })
  })
})
