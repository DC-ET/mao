// round.deliveries 收集（统一发送媒体方案 2026-11-18 D6/§7.1）：按调用顺序收 send_image / send_file
// 结果 JSON 里的 delivery；非目标工具、无结果、解析失败、无 delivery.url 一律不收。
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
