// 嵌入浮窗的投递条数据（统一发送媒体方案 2026-11-18 D6/D15）：从一轮工具结果收 delivery，
// message.toolCalls 与 segments 重复持有同一调用时按 toolCallId 去重。
// 活引用（2026-11-20）：delivery 可以是 url（形态 B/C）或 ref（形态 A），两者都收。
import { describe, expect, it } from 'vitest';
import { ref } from 'vue';
import { useRounds } from './useRounds';
import type { ChatMessage, ToolCallItem } from '../types';

function message(id: string, role: ChatMessage['role'], extra: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    role,
    content: '',
    thinking: '',
    streaming: false,
    error: false,
    segments: [],
    toolCalls: [],
    createdAt: '2026-11-19T10:00:00',
    ...extra,
  };
}

function call(toolCallId: string, toolName: string, resultText: string): ToolCallItem {
  return { toolCallId, toolName, displayName: toolName, argsText: '{}', status: 'done', resultText };
}

describe('useRounds：round.deliveries', () => {
  it('按调用顺序收 send_image / send_file；toolCalls 与 segments 的同一调用只收一次', () => {
    const image = call('t1', 'send_image', JSON.stringify({
      success: true, filename: 'a.png', delivery: { kind: 'image', url: 'https://h/uploads/7/send-1.png', mime: 'image/png', bytes: 12 },
    }));
    const file = call('t2', 'send_file', JSON.stringify({
      success: true, filename: 'r.pdf', delivery: { kind: 'file', url: 'https://h/uploads/7/send-2.pdf', bytes: 34 },
    }));
    const messages = ref<ChatMessage[]>([
      message('u1', 'user', { content: '发两件' }),
      message('a1', 'assistant', {
        content: '已发送',
        toolCalls: [image, file],
        segments: [{ type: 'tool-group', toolCalls: [image, file] }, { type: 'text', content: '已发送' }],
      }),
    ]);
    const { rounds } = useRounds(messages, ref(null));
    expect(rounds.value).toHaveLength(1);
    expect(rounds.value[0]!.deliveries).toEqual([
      { kind: 'image', url: 'https://h/uploads/7/send-1.png', mime: 'image/png', bytes: 12, filename: 'a.png' },
      { kind: 'file', url: 'https://h/uploads/7/send-2.pdf', mime: undefined, bytes: 34, filename: 'r.pdf' },
    ]);
  });

  it('非目标工具 / 副本失败 / 解析失败 / 无 url 不收', () => {
    const messages = ref<ChatMessage[]>([
      message('u1', 'user', { content: 'x' }),
      message('a1', 'assistant', {
        toolCalls: [
          call('t1', 'read_file', '{"content":"x"}'),
          call('t2', 'send_image', 'not json'),
          call('t3', 'send_file', JSON.stringify({ success: false, error: '文件不存在' })),
          call('t4', 'send_image', JSON.stringify({ success: true, delivery: { kind: 'image' } })),
        ],
      }),
    ]);
    const { rounds } = useRounds(messages, ref(null));
    expect(rounds.value[0]!.deliveries).toEqual([]);
  });

  it('活引用形态 A：ref 形态照常收集，无 url', () => {
    const messages = ref<ChatMessage[]>([
      message('u1', 'user', { content: '发图' }),
      message('a1', 'assistant', {
        toolCalls: [
          call('t1', 'send_image', JSON.stringify({
            success: true, filename: 'a.png',
            delivery: { kind: 'image', filename: 'a.png', mime: 'image/png', bytes: 12, ref: { type: 'workspace', sessionId: 42, path: 'reports/a.png' } },
          })),
        ],
      }),
    ]);
    const { rounds } = useRounds(messages, ref(null));
    expect(rounds.value[0]!.deliveries).toEqual([
      { kind: 'image', ref: { type: 'workspace', sessionId: 42, path: 'reports/a.png' }, mime: 'image/png', bytes: 12, filename: 'a.png' },
    ]);
  });

  it('活引用形态 A：ref 字段残缺（type/path/sessionId 不齐）不收', () => {
    const messages = ref<ChatMessage[]>([
      message('u1', 'user', { content: '发图' }),
      message('a1', 'assistant', {
        toolCalls: [
          call('t1', 'send_image', JSON.stringify({ success: true, delivery: { kind: 'image', ref: { type: 'workspace', sessionId: 42 } } })),
          call('t2', 'send_image', JSON.stringify({ success: true, delivery: { kind: 'image', ref: { type: 'workspace', path: 'a.png' } } })),
          call('t3', 'send_image', JSON.stringify({ success: true, delivery: { kind: 'image', ref: { type: 'other', sessionId: 42, path: 'a.png' } } })),
        ],
      }),
    ]);
    const { rounds } = useRounds(messages, ref(null));
    expect(rounds.value[0]!.deliveries).toEqual([]);
  });

  it('活引用形态 A：filename 与 delivery.filename 都缺失时回落 ref.path basename', () => {
    const messages = ref<ChatMessage[]>([
      message('u1', 'user', { content: '发文件' }),
      message('a1', 'assistant', {
        toolCalls: [
          call('t1', 'send_file', JSON.stringify({
            success: true, delivery: { kind: 'file', mime: 'application/pdf', ref: { type: 'workspace', sessionId: 42, path: 'docs/报告.pdf' } },
          })),
        ],
      }),
    ]);
    const { rounds } = useRounds(messages, ref(null));
    expect(rounds.value[0]!.deliveries).toEqual([
      { kind: 'file', ref: { type: 'workspace', sessionId: 42, path: 'docs/报告.pdf' }, mime: 'application/pdf', bytes: undefined, filename: '报告.pdf' },
    ]);
  });
});
