import { describe, expect, it, vi } from 'vitest';
import { RunTraceRecordService } from './run-trace-record.service.js';
import type { MessageRepository } from './session.repository.js';
import type { LlmCallRepository, LlmCallRow } from '../usage/llm-call.repository.js';
import type { Message } from './types.js';

/**
 * Bugcheck：findCall 的配对窗口方向（2026-10-23 审查 BUG-3）。
 *
 * run-trace-record.service.ts:66-73：
 *   call: await this.findCall(sessionId, assistantMessage?.createdAt, toolMessage?.createdAt)
 *   private async findCall(sessionId, startAt, endAt) {
 *     const rows = await this.llmCallRepo.selectBySessionWindow(sessionId, startAt, endAt);
 *     ...  // SQL：created_at >= startAt AND created_at < endAt
 *   }
 *
 * 窗口 = [助手消息 created_at, TOOL 消息 created_at)。
 *
 * 生产落库时序（可由代码完整推出）：
 *   1. agent-loop.ts:382-390  LlmCallContext.runAsync(...) 包住 llmAdapter.stream(...)；
 *      RecordingLlmAdapter.stream 的 finally 在流 resolve 后立即 record(...) 落 llm_call；
 *   2. agent-loop.ts:390 之后才 executeToolCalls(...)，再由 persistToolRound 在同一个
 *      事务里插 ASSISTANT + TOOL 消息。
 * ⇒ llm_call.created_at = C  <  工具执行耗时  <  A = 助手消息.created_at  <  T
 *
 * 同仓库 run-trace.service.ts:280 的 notAfter(entry.call.createdAt, message.createdAt)
 * 与 V142 迁移注释都确认「C ≤ A」这个方向。
 *
 * 因此窗口起点 A 恒大于 C：本轮的 llm_call 落在窗口之外，findCall 恒返回 null。
 * 既有 spec（run-trace-record.service.spec.ts:85-95）的 fixture 把 A 设得远早于 C，
 * 与生产时序正好相反，所以测不出这个方向性错误。
 */

function assistantMessage(id: number, createdAt: string, toolCallId: string): Message {
  return {
    id,
    sessionId: 1,
    role: 'ASSISTANT',
    content: null,
    createdAt,
    updatedAt: createdAt,
    toolCalls: JSON.stringify([{ id: toolCallId, function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }]),
  } as Message;
}

function toolMessage(id: number, createdAt: string, toolCallId: string): Message {
  return { id, sessionId: 1, role: 'TOOL', content: 'ok', toolCallId, metadata: null, createdAt, updatedAt: createdAt } as Message;
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
    cachedTokens: 0,
    cacheCreationTokens: 0,
    costMicros: null,
    success: 1,
    firstTokenMs: 800,
    durationMs: 4200,
    retryCount: 0,
    createdAt: '2026-10-22 10:00:04.200',
    ...over,
  } as LlmCallRow;
}

/** 按生产时序 C < A < T 造 fixture。 */
function makeService(calls: LlmCallRow[], assistant: Message | null, tool: Message | null) {
  const messageRepo = {
    selectToolMessageByCallId: vi.fn(async () => tool),
    selectAssistantByToolCallId: vi.fn(async () => assistant),
    selectAssistantToolCalls: vi.fn(async () => (assistant != null ? [assistant] : [])),
  } as unknown as MessageRepository;
  const llmCallRepo = {
    selectById: vi.fn(async (id: number) => calls.find((c) => c.id === id) ?? null),
    // 与 SQL 同口径：半开窗口 [startAt, endAt)
    selectBySessionWindow: vi.fn(async (_sid: number, startAt: string | null, endAt: string | null) =>
      calls
        .filter((c) => (startAt == null || (c.createdAt ?? '') >= startAt) && (endAt == null || (c.createdAt ?? '') < endAt))
        .sort((a, b) => ((a.createdAt ?? '') < (b.createdAt ?? '') ? -1 : 1))),
  } as unknown as LlmCallRepository;
  return { service: new RunTraceRecordService(messageRepo, llmCallRepo), messageRepo, llmCallRepo };
}

describe('findCall 配对窗口方向', () => {
  it('BUG-3：生产时序 C < A < T 下，本轮 llm_call 落在窗口外，配对恒为 null', async () => {
    // C = 10:00:04.200（流结束即落库）
    // A = 10:00:04.900（工具执行完后 persistToolRound 插助手消息，晚 700ms）
    // T = 10:00:04.950（TOOL 消息，晚 50ms）
    const { service } = makeService(
      [call()],
      assistantMessage(1, '2026-10-22 10:00:04.900', 'call_1'),
      toolMessage(2, '2026-10-22 10:00:04.950', 'call_1'),
    );
    const record = await service.buildToolRecord(1, 'call_1');
    // 期望：抽屉里能看到配对的 llm_call 元信息
    // 实际：C < A，窗口 [A, T) 不含 C → call 为 null
    expect(record.call).not.toBeNull();
    expect(record.call?.llmCallId).toBe(100);
  })

  it('BUG-3：同一方向性错误让 findRoundTools 把本轮助手消息排除在外', async () => {
    // llm_call C=10:00:04.200；本轮助手消息 A=10:00:04.900（晚于 C）
    // endMs = C，inWindow 要求 at <= endMs → A 被排除
    const { service } = makeService(
      [call()],
      assistantMessage(1, '2026-10-22 10:00:04.900', 'call_this'),
      toolMessage(2, '2026-10-22 10:00:04.950', 'call_this'),
    );
    const record = await service.buildCallRecord(1, 100);
    // 期望：「本轮工具」列出本轮自己声明的工具
    // 实际：A > C = endMs，本轮助手消息被排除 → 清单为空
    expect(record.tools.map((t) => t.toolCallId)).toContain('call_this');
  })

  it('既有 fixture 口径（A 远早于 C）能命中——这正是它掩盖方向错误的原因', async () => {
    // run-trace-record.service.spec.ts:85-95 的构造：A=10:00:00.000、T=10:00:04.300、C=10:00:04.200
    const { service } = makeService(
      [call()],
      assistantMessage(1, '2026-10-22 10:00:00.000', 'call_1'),
      toolMessage(2, '2026-10-22 10:00:04.300', 'call_1'),
    );
    const record = await service.buildToolRecord(1, 'call_1');
    expect(record.call?.llmCallId).toBe(100);
  })

  it('正确性基线：窗口任一端缺失时不猜（不配对）', async () => {
    const noTool = makeService([call()], assistantMessage(1, '2026-10-22 10:00:04.900', 'call_1'), null);
    const record = await noTool.service.buildToolRecord(1, 'call_1');
    expect(record.call).toBeNull()
  })
})
