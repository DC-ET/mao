import { describe, expect, it, vi } from 'vitest';
import { RunTraceRecordService } from './run-trace-record.service.js';
import type { MessageRepository } from './session.repository.js';
import type { LlmCallRepository, LlmCallRow } from '../usage/llm-call.repository.js';

/**
 * Bugcheck：findRoundTools 的「本轮工具」归属窗口（2026-10-23 审查 M-3）。
 *
 * run-trace-record.service.ts:96-121：
 *   const startMs = estimatedStartMs(call.createdAt, call.durationMs);   // = createdAt − duration
 *   const endMs = startMs + Math.max(0, call.durationMs ?? 0);           // = createdAt（恒等）
 *   ...
 *   return at >= startMs && at <= endMs;                                 // 闭区间
 *
 * 疑点一（串轮）：endMs 恒等于 call.created_at，上界用闭区间。下一轮的助手消息
 *   created_at 与本轮 llm_call.created_at 同刻时（两列都由 MySQL CURRENT_TIMESTAMP(3)
 *   生成、同一时钟源，工具轮耗时 <1ms 即可同刻），下一轮声明的工具会被算进本轮清单。
 *
 * 疑点二（口径不一致）：同一 service 内 selectBySessionWindow 用半开 [start, end)，
 *   findRoundTools 用闭区 [start, end]，两种窗口语义并存。
 *
 * 疑点三（全会话扫描）：selectAssistantToolCalls 无时间窗 / id 上界，每次点开轮次
 *   抽屉都对全会话助手消息的 tool_calls 做 JSON.parse，成本随会话规模线性增长。
 */

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
    cachedTokens: 0,
    cacheCreationTokens: 0,
    costMicros: null,
    success: 1,
    firstTokenMs: 800,
    durationMs: 4200,
    retryCount: 0,
    // 结束时刻 10:00:04.200，duration 4200 → 估算窗口 [09:59:59. ... , 10:00:04.200]
    createdAt: '2026-10-22 10:00:04.200',
    ...over,
  } as LlmCallRow;
}

function assistantToolRow(id: number, createdAt: string, callIds: string[]) {
  return {
    id,
    createdAt,
    toolCalls: JSON.stringify(callIds.map((c) => ({
      id: c,
      function: { name: 'read_file', arguments: '{"path":"a.txt"}' },
    }))),
  };
}

function makeService(rows: Array<{ id: number; createdAt: string | null; toolCalls: string | null }>, calls: LlmCallRow[]) {
  const messageRepo = {
    selectToolMessageByCallId: vi.fn(async () => null),
    selectAssistantByToolCallId: vi.fn(async () => null),
    // 与 SQL 同口径：upperCreatedAtExclusive 非 null 时只取 created_at 严格早于它的行
    selectAssistantToolCalls: vi.fn(async (_sid: number, upperCreatedAtExclusive?: string | null) =>
      upperCreatedAtExclusive == null
        ? rows
        : rows.filter((r) => (r.createdAt ?? '') < upperCreatedAtExclusive)),
  } as unknown as MessageRepository;
  const llmCallRepo = {
    selectById: vi.fn(async (id: number) => calls.find((c) => c.id === id) ?? null),
    // 与 SQL 同口径：半开窗口 [startAt, endAt)，两端 null 时取全会话
    selectBySessionWindow: vi.fn(async (_sid: number, startAt: string | null, endAt: string | null) =>
      calls
        .filter((c) => (startAt == null || (c.createdAt ?? '') >= startAt) && (endAt == null || (c.createdAt ?? '') < endAt))
        .sort((a, b) => ((a.createdAt ?? '') < (b.createdAt ?? '') ? -1 : (a.createdAt ?? '') > (b.createdAt ?? '') ? 1 : (a.id ?? 0) - (b.id ?? 0)))),
  } as unknown as LlmCallRepository;
  return { service: new RunTraceRecordService(messageRepo, llmCallRepo), messageRepo, llmCallRepo };
}

describe('findRoundTools 归属窗口', () => {
  /** 下一轮调用：created_at 更晚，作为本轮窗口的上界 */
  const nextCall = call({ id: 101, createdAt: '2026-10-22 10:00:09.000' });

  it('BUG-2/3 修复后：本轮助手消息（晚于本轮 llm_call 结束时刻）被正确纳入本轮', async () => {
    // 生产时序 C=10:00:04.200（调用结束即落库）< A=10:00:04.900（工具执行完后才落库）。
    // 修复前窗口上界恒等于 C 且闭区间，把 A 整个排除 → 本轮清单恒空。
    const { service } = makeService(
      [assistantToolRow(1, '2026-10-22 10:00:04.900', ['call_this'])],
      [call(), nextCall],
    );
    const record = await service.buildCallRecord(1, 100);
    expect(record.tools.map((t) => t.toolCallId)).toEqual(['call_this']);
  });

  it('BUG-3 修复后：下一轮助手消息不再串进本轮', async () => {
    // 下一轮助手消息要等下一轮工具跑完才落库，晚于下一轮 llm_call（10:00:09.000）
    const { service } = makeService(
      [
        assistantToolRow(1, '2026-10-22 10:00:04.900', ['call_this']),
        assistantToolRow(2, '2026-10-22 10:00:09.800', ['call_next']),
      ],
      [call(), nextCall],
    );
    const record = await service.buildCallRecord(1, 100);
    expect(record.tools.map((t) => t.toolCallId)).toEqual(['call_this']);
  });

  it('BUG-3 修复后：与下一轮 llm_call 同刻落库的消息归下一轮（上界排他）', async () => {
    // message.created_at 与 llm_call.created_at 都由 MySQL CURRENT_TIMESTAMP(3) 生成，
    // 工具轮耗时 <1ms 时两行同刻落库可达；上界用严格小于，同刻归下一轮。
    const { service } = makeService(
      [
        assistantToolRow(1, '2026-10-22 10:00:04.900', ['call_this']),
        assistantToolRow(2, '2026-10-22 10:00:09.000', ['call_next']),
      ],
      [call(), nextCall],
    );
    const record = await service.buildCallRecord(1, 100);
    expect(record.tools.map((t) => t.toolCallId)).toEqual(['call_this']);
  });

  it('BUG-4 修复后：时间窗下推 SQL，仓库层收到下一轮上界参数', async () => {
    // 5000 条窗外的助手消息（晚于下一轮 llm_call 的 10:00:09.000）+ 1 条窗内的本轮消息。
    // 修复前每次点抽屉都全量 parse 这 5000 条；现在由 SQL 先裁掉，只 parse 窗内的行。
    const rows = Array.from({ length: 5000 }, (_, i) =>
      assistantToolRow(i + 1, '2026-10-22 10:00:20.000', [`old_${i}`]));
    rows.push(assistantToolRow(5001, '2026-10-22 10:00:04.900', ['call_this']));
    const { service, messageRepo } = makeService(rows, [call(), nextCall]);
    const record = await service.buildCallRecord(1, 100);
    const select = messageRepo.selectAssistantToolCalls as unknown as { mock: { calls: unknown[][] } };
    // 期望：仓库层拿到 sessionId + 下一轮 llm_call.created_at 上界，由 SQL 裁行
    expect(select.mock.calls).toEqual([[1, '2026-10-22 10:00:09.000']]);
    expect(record.tools.map((t) => t.toolCallId)).toEqual(['call_this']);
  });

  it('正确性基线：本轮就是最后一轮时上界开放，取到会话最新一条助手消息', async () => {
    const { service, messageRepo } = makeService(
      [assistantToolRow(1, '2026-10-22 10:00:04.900', ['call_this'])],
      [call()],
    );
    const record = await service.buildCallRecord(1, 100);
    const select = messageRepo.selectAssistantToolCalls as unknown as { mock: { calls: unknown[][] } };
    expect(select.mock.calls).toEqual([[1, null]]);
    expect(record.tools.map((t) => t.toolCallId)).toEqual(['call_this']);
  })

  it('正确性基线：本轮之前的历史工具不会被算进本轮', async () => {
    // 历史助手消息早于本轮 llm_call 结束时刻，本就不该出现在本轮清单里
    const { service } = makeService(
      [
        assistantToolRow(1, '2026-10-22 10:00:01.000', ['call_a', 'call_b']),
        assistantToolRow(2, '2026-10-22 09:00:00.000', ['call_old']),
      ],
      [call({ createdAt: '2026-10-22 09:59:00.000' }), call({ id: 101, createdAt: '2026-10-22 10:00:09.000' })],
    );
    const record = await service.buildCallRecord(1, 100);
    expect(record.tools.map((t) => t.toolCallId).sort()).toEqual(['call_a', 'call_b', 'call_old']);
  })

  it('正确性基线：时钟缺失时退化为全会话清单（不猜归属）', async () => {
    const { service } = makeService(
      [
        assistantToolRow(1, '2026-10-22 10:00:04.900', ['call_a']),
        assistantToolRow(2, '2026-10-22 09:00:00.000', ['call_b']),
      ],
      [call({ createdAt: null })],
    );
    const record = await service.buildCallRecord(1, 100);
    expect(record.tools.map((t) => t.toolCallId).sort()).toEqual(['call_a', 'call_b']);
  })
})
