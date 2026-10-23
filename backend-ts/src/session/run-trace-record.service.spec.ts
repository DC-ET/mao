import { describe, expect, it, vi } from 'vitest';
import { RunTraceRecordService } from './run-trace-record.service.js';
import type { MessageRepository } from './session.repository.js';
import type { LlmCallRepository, LlmCallRow } from '../usage/llm-call.repository.js';
import type { Message } from './types.js';

interface Fixture {
  /** TOOL 消息：按 tool_call_id 反查的结果 */
  toolMessages: Message[];
  /** 助手消息：按 tool_call_id 反查的结果 */
  assistantMessages: Message[];
  /** 全会话助手消息声明的工具调用（含 created_at） */
  assistantToolCalls: Array<{ id: number; createdAt: string | null; toolCalls: string | null }>;
  calls: LlmCallRow[];
}

function assistantMessage(id: number, createdAt: string, toolCalls: Array<{ id: string; name: string; args?: string }>): Message {
  return {
    id,
    sessionId: 1,
    role: 'ASSISTANT',
    content: null,
    createdAt,
    updatedAt: createdAt,
    toolCalls: JSON.stringify(toolCalls.map((tc) => ({ id: tc.id, function: { name: tc.name, arguments: tc.args ?? '{}' } }))),
  } as Message;
}

function toolMessage(id: number, createdAt: string, toolCallId: string, content: string, metadata?: string): Message {
  return { id, sessionId: 1, role: 'TOOL', content, toolCallId, metadata, createdAt, updatedAt: createdAt } as Message;
}

function call(over: Partial<LlmCallRow> = {}): LlmCallRow {
  return {
    id: 100,
    sessionId: 1,
    scene: 'agent',
    modelName: 'step-5',
    provider: 'anthropic',
    protocol: 'anthropic_messages',
    stream: 1,
    effort: 'medium',
    promptTokens: 1000,
    completionTokens: 200,
    cachedTokens: 300,
    cacheCreationTokens: 40,
    costMicros: 2_500_000,
    success: 1,
    firstTokenMs: 800,
    durationMs: 4200,
    retryCount: 1,
    createdAt: '2026-10-22 10:00:04.200',
    ...over,
  };
}

function makeService(fixture: Fixture) {
  const messageRepo = {
    selectToolMessageByCallId: vi.fn(async (_sid: number, toolCallId: string) =>
      fixture.toolMessages.find((m) => m.toolCallId === toolCallId) ?? null),
    selectAssistantByToolCallId: vi.fn(async (_sid: number, toolCallId: string) => {
      for (const message of fixture.assistantMessages) {
        const raw = message.toolCalls;
        if (raw == null) continue;
        const parsed = JSON.parse(raw) as Array<{ id?: string }>;
        if (Array.isArray(parsed) && parsed.some((entry) => entry?.id === toolCallId)) return message;
      }
      return null;
    }),
    // 与 SQL 同口径：lower 含、upper 不含；任一侧 null 表示该侧开放
    selectAssistantToolCalls: vi.fn(async (
      _sid: number,
      upperCreatedAtExclusive?: string | null,
      lowerCreatedAtInclusive?: string | null,
    ) => fixture.assistantToolCalls.filter((r) => {
      const createdAt = r.createdAt ?? '';
      return (lowerCreatedAtInclusive == null || createdAt >= lowerCreatedAtInclusive)
        && (upperCreatedAtExclusive == null || createdAt < upperCreatedAtExclusive);
    })),
  } as unknown as MessageRepository;
  const llmCallRepo = {
    selectById: vi.fn(async (id: number) => fixture.calls.find((c) => c.id === id) ?? null),
    // 与 SQL 同口径：半开窗口 [startAt, endAt)
    selectBySessionWindow: vi.fn(async (_sid: number, startAt: string | null, endAt: string | null) =>
      fixture.calls
        .filter((c) => (startAt == null || (c.createdAt ?? '') >= startAt) && (endAt == null || (c.createdAt ?? '') < endAt))
        .sort((a, b) => ((a.createdAt ?? '') < (b.createdAt ?? '') ? -1 : (a.createdAt ?? '') > (b.createdAt ?? '') ? 1 : (a.id ?? 0) - (b.id ?? 0)))),
  } as unknown as LlmCallRepository;
  return { service: new RunTraceRecordService(messageRepo, llmCallRepo), messageRepo, llmCallRepo };
}

describe('RunTraceRecordService.buildToolRecord', () => {
  it('配对成功：参数 / 结果原文 + TOOL metadata + llm_call 全量元信息', async () => {
    const { service } = makeService({
      toolMessages: [toolMessage(3, '2026-10-22 10:00:04.300', 'tc1', '{"content":"ok"}', '{"approvalMark":{"mode":"jev"}}')],
      assistantMessages: [assistantMessage(2, '2026-10-22 10:00:04.900', [{ id: 'tc1', name: 'read_file', args: '{"path":"a.ts"}' }])],
      assistantToolCalls: [{ id: 2, createdAt: '2026-10-22 10:00:04.900', toolCalls: JSON.stringify([{ id: 'tc1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }]) }],
      calls: [call()],
    });
    const record = await service.buildToolRecord(1, 'tc1');
    expect(record.toolName).toBe('read_file');
    expect(record.argumentsJson).toBe('{"path":"a.ts"}');
    expect(record.resultContent).toBe('{"content":"ok"}');
    expect(record.resultMetadata).toBe('{"approvalMark":{"mode":"jev"}}');
    // 配对窗口 = (−∞, TOOL 消息 10:00:04.300)，下界刻意开放：
    // 该 agent 调用结束于 10:00:04.200，早于本轮助手消息的落库时刻 10:00:04.900（C < A）
    expect(record.call).toMatchObject({
      llmCallId: 100, provider: 'anthropic', protocol: 'anthropic_messages', stream: true, effort: 'medium',
      scene: 'agent', modelName: 'step-5', retryCount: 1, firstTokenMs: 800, durationMs: 4200,
      promptTokens: 1000, completionTokens: 200, cachedTokens: 300, cacheCreationTokens: 40,
      costMicros: 2_500_000, createdAt: '2026-10-22 10:00:04.200',
    });
  });

  it('tool_call_id 不存在 → 空态 VO（全 null，不抛错）', async () => {
    const { service } = makeService({ toolMessages: [], assistantMessages: [], assistantToolCalls: [], calls: [] });
    expect(await service.buildToolRecord(1, 'nope')).toEqual({
      toolCallId: 'nope', toolName: null, argumentsJson: null, resultContent: null, resultMetadata: null, call: null,
    });
  });

  it('空 toolCallId 直接返回空态，不发查询', async () => {
    const { service, messageRepo, llmCallRepo } = makeService({ toolMessages: [], assistantMessages: [], assistantToolCalls: [], calls: [] });
    expect((await service.buildToolRecord(1, '')).toolCallId).toBe('');
    expect(messageRepo.selectToolMessageByCallId).not.toHaveBeenCalled();
    expect(llmCallRepo.selectBySessionWindow).not.toHaveBeenCalled();
  });

  it('上界之后没有 agent 调用 → call 为 null（不跨窗猜）', async () => {
    const { service } = makeService({
      toolMessages: [toolMessage(3, '2026-10-22 10:00:04.300', 'tc1', '{"content":"ok"}')],
      assistantMessages: [assistantMessage(2, '2026-10-22 10:00:00.000', [{ id: 'tc1', name: 'shell', args: '{}' }])],
      assistantToolCalls: [],
      // 唯一的 agent 调用结束于 11:00，晚于 TOOL 消息的 10:00:04.300（上界排他）
      calls: [call({ createdAt: '2026-10-22 11:00:04.200' })],
    });
    const record = await service.buildToolRecord(1, 'tc1');
    expect(record.resultContent).toBe('{"content":"ok"}');
    expect(record.call).toBeNull();
  });

  it('窗口内多条 agent 调用取最后一条（与工具组挂轮同一口径）', async () => {
    const { service } = makeService({
      toolMessages: [toolMessage(3, '2026-10-22 10:00:09.000', 'tc1', '{"ok":true}')],
      assistantMessages: [assistantMessage(2, '2026-10-22 10:00:00.000', [{ id: 'tc1', name: 'shell', args: '{}' }])],
      assistantToolCalls: [],
      calls: [
        call({ id: 1, createdAt: '2026-10-22 10:00:02.000', modelName: 'first' }),
        call({ id: 2, createdAt: '2026-10-22 10:00:06.000', modelName: 'last' }),
      ],
    });
    const record = await service.buildToolRecord(1, 'tc1');
    expect(record.call?.llmCallId).toBe(2);
    expect(record.call?.modelName).toBe('last');
  });

  it('窗口内只有旁路调用（scene 非 agent）→ call 为 null', async () => {
    const { service } = makeService({
      toolMessages: [toolMessage(3, '2026-10-22 10:00:09.000', 'tc1', '{"ok":true}')],
      assistantMessages: [assistantMessage(2, '2026-10-22 10:00:00.000', [{ id: 'tc1', name: 'shell', args: '{}' }])],
      assistantToolCalls: [],
      calls: [call({ id: 1, scene: 'session_title', createdAt: '2026-10-22 10:00:06.000' })],
    });
    expect((await service.buildToolRecord(1, 'tc1')).call).toBeNull();
  });

  it('缺任一侧时钟（助手消息或 TOOL 消息缺失）→ 不配对', async () => {
    const { service } = makeService({
      toolMessages: [],
      assistantMessages: [assistantMessage(2, '2026-10-22 10:00:00.000', [{ id: 'tc1', name: 'shell', args: '{}' }])],
      assistantToolCalls: [],
      calls: [call()],
    });
    const record = await service.buildToolRecord(1, 'tc1');
    expect(record.toolName).toBe('shell');
    expect(record.resultContent).toBeNull();
    expect(record.call).toBeNull();
  });

  it('助手消息里没有该 tool_call_id（历史截断）→ toolName / argumentsJson 为 null', async () => {
    const { service } = makeService({
      toolMessages: [toolMessage(3, '2026-10-22 10:00:04.300', 'tc1', '{"ok":true}')],
      assistantMessages: [assistantMessage(2, '2026-10-22 10:00:00.000', [{ id: 'other', name: 'shell', args: '{}' }])],
      assistantToolCalls: [],
      calls: [call()],
    });
    const record = await service.buildToolRecord(1, 'tc1');
    expect(record.toolName).toBeNull();
    expect(record.argumentsJson).toBeNull();
    expect(record.resultContent).toBe('{"ok":true}');
  });
});

describe('RunTraceRecordService.buildCallRecord', () => {
  it('llm_call 归属本会话 → 元信息 + 本轮工具', async () => {
    const { service } = makeService({
      toolMessages: [],
      assistantMessages: [],
      assistantToolCalls: [
        // 本轮助手消息：工具跑完后才落库，晚于本轮 llm_call 的 10:00:04.200
        { id: 2, createdAt: '2026-10-22 10:00:04.900', toolCalls: JSON.stringify([{ id: 'tc1', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }]) },
        { id: 5, createdAt: '2026-10-22 10:00:05.100', toolCalls: JSON.stringify([{ id: 'tc2', function: { name: 'shell', arguments: '{"command":"ls"}' } }]) },
        // 下一轮的助手消息：晚于下一轮 llm_call 的 10:00:09.000，该被上界排除
        { id: 9, createdAt: '2026-10-22 10:00:09.800', toolCalls: JSON.stringify([{ id: 'tc3', function: { name: 'glob', arguments: '{"pattern":"*.ts"}' } }]) },
      ],
      calls: [call(), call({ id: 101, createdAt: '2026-10-22 10:00:09.000' })],
    });
    const record = await service.buildCallRecord(1, 100);
    expect(record.call?.llmCallId).toBe(100);
    expect(record.tools.map((t) => t.toolCallId)).toEqual(['tc1', 'tc2']);
    expect(record.tools[0]).toEqual({ toolCallId: 'tc1', name: 'read_file', target: 'a.ts' });
    expect(record.tools[1]).toEqual({ toolCallId: 'tc2', name: 'shell', target: 'ls' });
  });

  it('llm_call 的 sessionId 与路径会话不一致 → 空态 VO（防越权读）', async () => {
    const { service } = makeService({
      toolMessages: [],
      assistantMessages: [],
      assistantToolCalls: [{ id: 2, createdAt: '2026-10-22 10:00:01.000', toolCalls: JSON.stringify([{ id: 'tc1', function: { name: 'shell', arguments: '{}' } }]) }],
      calls: [call({ sessionId: 2 })],
    });
    expect(await service.buildCallRecord(1, 100)).toEqual({ call: null, tools: [] });
  });

  it('llm_call 不存在 → 空态 VO', async () => {
    const { service } = makeService({ toolMessages: [], assistantMessages: [], assistantToolCalls: [], calls: [] });
    expect(await service.buildCallRecord(1, 999)).toEqual({ call: null, tools: [] });
  });

  it('llmCallId 非正整数（0 / 负数 / 小数）→ 空态 VO，不发查询', async () => {
    const { service, llmCallRepo } = makeService({ toolMessages: [], assistantMessages: [], assistantToolCalls: [], calls: [] });
    expect(await service.buildCallRecord(1, 0)).toEqual({ call: null, tools: [] });
    expect(await service.buildCallRecord(1, -5)).toEqual({ call: null, tools: [] });
    expect(await service.buildCallRecord(1, 1.5)).toEqual({ call: null, tools: [] });
    expect(llmCallRepo.selectById).not.toHaveBeenCalled();
  });

  it('llm_call.sessionId 为 null（无归属调用）→ 空态 VO', async () => {
    const { service } = makeService({
      toolMessages: [], assistantMessages: [], assistantToolCalls: [], calls: [call({ sessionId: null })],
    });
    expect(await service.buildCallRecord(1, 100)).toEqual({ call: null, tools: [] });
  });

  it('窗口不可估算（createdAt 或 durationMs 缺失）→ 退化为全会话清单，不空列表误导', async () => {
    const { service } = makeService({
      toolMessages: [],
      assistantMessages: [],
      assistantToolCalls: [
        { id: 2, createdAt: '2026-10-22 10:00:01.000', toolCalls: JSON.stringify([{ id: 'tc1', function: { name: 'shell', arguments: '{}' } }]) },
        { id: 9, createdAt: '2026-10-22 10:05:00.000', toolCalls: JSON.stringify([{ id: 'tc3', function: { name: 'shell', arguments: '{}' } }]) },
      ],
      calls: [call({ createdAt: null })],
    });
    const record = await service.buildCallRecord(1, 100);
    expect(record.tools.map((t) => t.toolCallId)).toEqual(['tc1', 'tc3']);
  });

  it('助手消息 tool_calls 解析失败 / 空 id 的条目被跳过', async () => {
    const { service } = makeService({
      toolMessages: [],
      assistantMessages: [],
      assistantToolCalls: [
        { id: 2, createdAt: '2026-10-22 10:00:04.900', toolCalls: 'not-json' },
        { id: 3, createdAt: '2026-10-22 10:00:05.000', toolCalls: JSON.stringify([{ id: '', function: { name: 'shell', arguments: '{}' } }]) },
        { id: 4, createdAt: '2026-10-22 10:00:05.100', toolCalls: JSON.stringify([{ id: 'tc4', function: { name: 'shell', arguments: '{}' } }]) },
      ],
      calls: [call()],
    });
    const record = await service.buildCallRecord(1, 100);
    expect(record.tools.map((t) => t.toolCallId)).toEqual(['tc4']);
  });
});
