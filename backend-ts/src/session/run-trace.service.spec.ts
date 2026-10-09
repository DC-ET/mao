import { describe, expect, it, vi } from 'vitest';
import { RunTraceService } from './run-trace.service.js';
import type { MessageRepository } from './session.repository.js';
import type { LlmCallRepository, LlmCallRow } from '../usage/llm-call.repository.js';
import type { SessionActivityRepository } from './activity.repository.js';
import type { SessionCompactionEventRepository } from './session-compaction.repository.js';
import type { Message, SessionActivity, SessionCompactionEvent } from './types.js';

interface Stamp {
  id: number;
  createdAt: string;
  updatedAt: string;
}

interface Fixture {
  messages: Array<Message & { id: number }>;
  calls: Array<LlmCallRow & { id: number }>;
  activities: Array<SessionActivity & { id: number }>;
  events: SessionCompactionEvent[];
}

function user(id: number, createdAt: string, content = `u${id}`, updatedAt?: string): Message & { id: number } {
  return { id, sessionId: 1, role: 'USER', content, createdAt, updatedAt: updatedAt ?? createdAt };
}

function assistant(id: number, createdAt: string, toolCalls: Array<{ id: string; name: string; args?: string }>): Message & { id: number } {
  return {
    id,
    sessionId: 1,
    role: 'ASSISTANT',
    content: toolCalls.length === 0 ? 'done' : null,
    createdAt,
    updatedAt: createdAt,
    toolCalls: JSON.stringify(toolCalls.map((tc) => ({ id: tc.id, function: { name: tc.name, arguments: tc.args ?? '{}' } }))),
  };
}

function toolMessage(id: number, createdAt: string, toolCallId: string, content: string, metadata?: string): Message & { id: number } {
  return { id, sessionId: 1, role: 'TOOL', content, toolCallId, metadata, createdAt, updatedAt: createdAt };
}

function call(id: number, over: Partial<LlmCallRow> = {}): LlmCallRow & { id: number } {
  return {
    id,
    sessionId: 1,
    scene: 'agent',
    modelName: 'gpt',
    promptTokens: 100,
    completionTokens: 50,
    cachedTokens: 10,
    cacheCreationTokens: 0,
    totalTokens: 160,
    costMicros: 1000,
    success: 1,
    durationMs: 1000,
    retryCount: 0,
    firstTokenMs: 100,
    createdAt: '2026-10-09 10:00:00',
    ...over,
  };
}

function activity(id: number, over: Partial<SessionActivity> = {}): SessionActivity & { id: number } {
  return {
    id,
    sessionId: 1,
    type: 'RUN',
    target: 'ls',
    summary: '执行 ls',
    detailJson: JSON.stringify({ toolCallId: `tc${id}` }),
    status: 'SUCCESS',
    durationMs: 500,
    createdAt: '2026-10-09 10:00:01',
    ...over,
  };
}

function makeService(fixture: Fixture) {
  const messageRepo = {
    selectUserStarts: vi.fn(async (_sid: number, beforeId: number | null, limit: number) => {
      const rows = fixture.messages
        .filter((m) => m.role === 'USER' && (beforeId == null || m.id < beforeId))
        .sort((a, b) => b.id - a.id)
        .slice(0, limit);
      return rows;
    }),
    selectRange: vi.fn(async (_sid: number, startId: number, beforeId: number | null) => {
      return fixture.messages
        .filter((m) => m.id >= startId && (beforeId == null || m.id < beforeId))
        .sort((a, b) => a.id - b.id);
    }),
    selectUserStamps: vi.fn(async () =>
      fixture.messages
        .filter((m) => m.role === 'USER')
        .map((m) => ({ id: m.id, createdAt: m.createdAt ?? null, updatedAt: m.updatedAt ?? null }))
        .sort((a, b) => a.id - b.id),
    ),
  } as unknown as MessageRepository;
  const llmCallRepo = {
    selectBySessionWindow: vi.fn(async (_sid: number, startAt: string | null, endAt: string | null) => {
      return fixture.calls
        .filter((c) => (startAt == null || (c.createdAt ?? '') >= startAt) && (endAt == null || (c.createdAt ?? '') < endAt))
        .sort((a, b) => ((a.createdAt ?? '') < (b.createdAt ?? '') ? -1 : (a.createdAt ?? '') > (b.createdAt ?? '') ? 1 : a.id - b.id));
    }),
  } as unknown as LlmCallRepository;
  const activityRepo = {
    selectBySessionAll: vi.fn(async () => [...fixture.activities].sort((a, b) => a.id - b.id)),
  } as unknown as SessionActivityRepository;
  const compactionEventRepo = {
    selectBySessionId: vi.fn(async () => fixture.events),
  } as unknown as SessionCompactionEventRepository;
  return new RunTraceService(messageRepo, llmCallRepo, activityRepo, compactionEventRepo);
}

const QUERY = { beforeRunId: null, limit: 5, slowMs: 60_000, expensiveTokens: 50_000 };

describe('RunTraceService', () => {
  it('groups parallel tools of one assistant message into the same round', async () => {
    const service = makeService({
      messages: [
        user(1, '2026-10-09 10:00:00', '查一下'),
        assistant(2, '2026-10-09 10:00:05', [
          { id: 'tc1', name: 'read_file', args: '{"path":"a.ts"}' },
          { id: 'tc2', name: 'read_file', args: '{"path":"b.ts"}' },
        ]),
        toolMessage(3, '2026-10-09 10:00:06', 'tc1', '{"content":"a"}'),
        toolMessage(4, '2026-10-09 10:00:06', 'tc2', '{"content":"b"}'),
      ],
      calls: [call(1, { createdAt: '2026-10-09 10:00:02', durationMs: 2000 })],
      activities: [activity(1, { type: 'READ', target: 'a.ts', detailJson: JSON.stringify({ toolCallId: 'tc1' }), durationMs: 400, createdAt: '2026-10-09 10:00:06' }), activity(2, { type: 'READ', target: 'b.ts', detailJson: JSON.stringify({ toolCallId: 'tc2' }), durationMs: 600, createdAt: '2026-10-09 10:00:06' })],
      events: [],
    });
    const page = await service.buildTrace(1, QUERY);
    expect(page.runs).toHaveLength(1);
    const run = page.runs[0];
    expect(run.runId).toBe(1);
    expect(run.segments).toHaveLength(1);
    expect(run.segments[0].kind).toBe('current');
    expect(run.segments[0].rounds).toHaveLength(1);
    const round = run.segments[0].rounds[0];
    expect(round.tools.map((t) => t.toolCallId)).toEqual(['tc1', 'tc2']);
    expect(round.tools[0].name).toBe('read_file');
    expect(round.tools[0].target).toBe('a.ts');
    expect(round.tools[0].durationMs).toBe(400);
    expect(run.segments[0].unplacedTools).toHaveLength(0);
    // 墙钟 = 最晚结束 − 最早起点（10:00:06 − (10:00:02 − 2s)）
    expect(run.totals.wallClockMs).toBe(6000);
    expect(run.totals.toolSuccess).toBe(2);
    expect(run.totals.toolError).toBe(0);
  });

  it('attributes late-inserted activity to the original run by tool_call_id', async () => {
    const service = makeService({
      messages: [
        user(1, '2026-10-09 10:00:00', '第一轮'),
        assistant(2, '2026-10-09 10:00:05', [{ id: 'tc1', name: 'shell', args: '{"command":"ls"}' }]),
        toolMessage(3, '2026-10-09 10:00:06', 'tc1', '{"ok":true}'),
        user(4, '2026-10-09 10:00:30', '第二轮'),
        assistant(5, '2026-10-09 10:00:35', [{ id: 'tc2', name: 'shell', args: '{"command":"pwd"}' }]),
        toolMessage(6, '2026-10-09 10:00:36', 'tc2', '{"ok":true}'),
      ],
      calls: [
        call(1, { createdAt: '2026-10-09 10:00:02' }),
        call(2, { createdAt: '2026-10-09 10:00:32' }),
      ],
      // tc1 的活动异步晚插入：created_at 落入下一条用户消息之后
      activities: [
        activity(1, { detailJson: JSON.stringify({ toolCallId: 'tc1' }), createdAt: '2026-10-09 10:00:31' }),
        activity(2, { detailJson: JSON.stringify({ toolCallId: 'tc2' }), createdAt: '2026-10-09 10:00:36' }),
      ],
      events: [],
    });
    const page = await service.buildTrace(1, QUERY);
    expect(page.runs.map((r) => r.runId)).toEqual([4, 1]);
    const first = page.runs[1];
    expect(first.segments[0].rounds[0].tools.map((t) => t.toolCallId)).toEqual(['tc1']);
    expect(first.segments[0].unplacedTools).toHaveLength(0);
    const second = page.runs[0];
    expect(second.segments[0].rounds[0].tools.map((t) => t.toolCallId)).toEqual(['tc2']);
    expect(second.segments[0].unplacedTools).toHaveLength(0);
  });

  it('leaves tool groups in unplacedTools when same-second candidates are ambiguous', async () => {
    const service = makeService({
      messages: [
        user(1, '2026-10-09 10:00:00', '开始'),
        // 空响应重试：同一秒两条 agent 调用，助手消息晚于它们
        assistant(2, '2026-10-09 10:00:09', [{ id: 'tc1', name: 'shell', args: '{"command":"ls"}' }]),
        toolMessage(3, '2026-10-09 10:00:10', 'tc1', '{"ok":true}'),
      ],
      calls: [
        call(1, { createdAt: '2026-10-09 10:00:03' }),
        call(2, { createdAt: '2026-10-09 10:00:03' }),
      ],
      activities: [activity(1, { detailJson: JSON.stringify({ toolCallId: 'tc1' }) })],
      events: [],
    });
    const page = await service.buildTrace(1, QUERY);
    const run = page.runs[0];
    expect(run.segments[0].rounds).toHaveLength(2);
    expect(run.segments[0].rounds[0].tools).toHaveLength(0);
    expect(run.segments[0].rounds[1].tools).toHaveLength(0);
    expect(run.segments[0].unplacedTools.map((t) => t.toolCallId)).toEqual(['tc1']);
    // 未挂到轮的活动仍计入工具成败
    expect(run.totals.toolSuccess).toBe(1);
  });

  it('marks Cancelled by user rounds as interrupted and not failed', async () => {
    const service = makeService({
      messages: [user(1, '2026-10-09 10:00:00', '跑')],
      calls: [
        call(1, { createdAt: '2026-10-09 10:00:02', success: 0, errorMessage: 'Cancelled by user' }),
        call(2, { createdAt: '2026-10-09 10:00:10', success: 0, errorMessage: 'boom' }),
      ],
      activities: [],
      events: [],
    });
    const page = await service.buildTrace(1, QUERY);
    const rounds = page.runs[0].segments[0].rounds;
    expect(rounds).toHaveLength(2);
    expect(rounds[0].interrupted).toBe(true);
    expect(rounds[0].success).toBe(false);
    expect(rounds[1].interrupted).toBe(false);
    expect(rounds[1].errorMessage).toBe('boom');
  });

  it('keeps empty-response retries as consecutive successful rounds without retry badge', async () => {
    const service = makeService({
      messages: [user(1, '2026-10-09 10:00:00', '在吗')],
      calls: [
        call(1, { createdAt: '2026-10-09 10:00:02', retryCount: 0 }),
        call(2, { createdAt: '2026-10-09 10:00:12', retryCount: 0 }),
      ],
      activities: [],
      events: [],
    });
    const page = await service.buildTrace(1, QUERY);
    const rounds = page.runs[0].segments[0].rounds;
    expect(rounds.map((r) => r.seq)).toEqual([1, 2]);
    expect(rounds.every((r) => r.success && r.retryCount === 0 && !r.interrupted)).toBe(true);
  });

  it('keeps side scene calls out of seq but inside run totals', async () => {
    const service = makeService({
      messages: [user(1, '2026-10-09 10:00:00', '你好')],
      calls: [
        call(1, { id: 1, scene: 'agent', createdAt: '2026-10-09 10:00:02', costMicros: 1000 }),
        call(2, { id: 2, scene: 'compaction', createdAt: '2026-10-09 10:00:20', promptTokens: 900, completionTokens: 100, cachedTokens: 0, cacheCreationTokens: 0, costMicros: 500, durationMs: 3000 }),
        call(3, { id: 3, scene: 'session_title', createdAt: '2026-10-09 10:00:25', promptTokens: 20, completionTokens: 5, cachedTokens: 0, cacheCreationTokens: 0, costMicros: 10 }),
      ],
      activities: [],
      events: [],
    });
    const page = await service.buildTrace(1, QUERY);
    const run = page.runs[0];
    expect(run.segments[0].rounds).toHaveLength(1);
    expect(run.sideCalls.map((s) => s.scene)).toEqual(['compaction', 'session_title']);
    expect(run.totals.promptTokens).toBe(1020);
    expect(run.totals.completionTokens).toBe(155);
    expect(run.totals.costMicros).toBe(1510);
    // 墙钟含旁路调用：10:00:25 − (10:00:02 − 1s)
    expect(run.totals.wallClockMs).toBe(24000);
  });

  it('nulls run cost when any call in the window is unpriced', async () => {
    const service = makeService({
      messages: [user(1, '2026-10-09 10:00:00', '你好')],
      calls: [
        call(1, { createdAt: '2026-10-09 10:00:02', costMicros: 1000 }),
        call(2, { id: 2, scene: 'compaction', createdAt: '2026-10-09 10:00:20', costMicros: null }),
      ],
      activities: [],
      events: [],
    });
    const page = await service.buildTrace(1, QUERY);
    expect(page.runs[0].totals.costMicros).toBeNull();
    expect(page.runs[0].sideCalls[0].costMicros).toBeNull();
  });

  it('splits before_edit segment by anchor updated_at', async () => {
    const service = makeService({
      messages: [
        // 编辑过一次：updated_at 之后的调用归 current，之前的归 before_edit
        user(1, '2026-10-09 10:00:00', '改需求', '2026-10-09 10:01:00'),
        assistant(2, '2026-10-09 10:01:05', [{ id: 'tc1', name: 'shell', args: '{"command":"ls"}' }]),
        toolMessage(3, '2026-10-09 10:01:06', 'tc1', '{"ok":true}'),
      ],
      calls: [
        call(1, { createdAt: '2026-10-09 10:00:02' }),
        call(2, { id: 2, createdAt: '2026-10-09 10:01:02' }),
      ],
      activities: [
        // 编辑前被截断的旧工具：tool_call_id 对不上任何现存消息
        activity(1, { detailJson: JSON.stringify({ toolCallId: 'old-tc' }), createdAt: '2026-10-09 10:00:30', summary: '执行旧命令', type: 'RUN' }),
        activity(2, { detailJson: JSON.stringify({ toolCallId: 'tc1' }), createdAt: '2026-10-09 10:01:06' }),
      ],
      events: [],
    });
    const page = await service.buildTrace(1, QUERY);
    const run = page.runs[0];
    expect(run.segments).toHaveLength(2);
    expect(run.segments[0].kind).toBe('before_edit');
    expect(run.segments[0].rounds).toHaveLength(1);
    expect(run.segments[0].unplacedTools.map((t) => t.toolCallId)).toEqual(['old-tc']);
    expect(run.segments[1].kind).toBe('current');
    expect(run.segments[1].rounds).toHaveLength(1);
    // 对得上现存消息的工具永远归当前段
    expect(run.segments[1].rounds[0].tools.map((t) => t.toolCallId)).toEqual(['tc1']);
  });

  it('does not fabricate an empty before_edit segment when never edited', async () => {
    const service = makeService({
      messages: [user(1, '2026-10-09 10:00:00', '你好')],
      calls: [call(1, { createdAt: '2026-10-09 10:00:02' })],
      activities: [],
      events: [],
    });
    const page = await service.buildTrace(1, QUERY);
    expect(page.runs[0].segments).toHaveLength(1);
    expect(page.runs[0].segments[0].kind).toBe('current');
  });

  it('keeps a cancelled run in the current segment when the anchor USER message was never edited', async () => {
    // 取消命中工具阶段时助手消息未落库，最后一条就是锚点 USER 消息；
    // markLastMessageFinished 跳过 USER（updated_at 仅编辑时填充），锚点时间戳不变，
    // 这一轮必须留在「当前」段，不能被误判成编辑重发。
    const service = makeService({
      messages: [user(1, '2026-10-09 10:00:00', '跑个长命令')],
      calls: [call(1, { createdAt: '2026-10-09 10:00:30', durationMs: 5000 })],
      activities: [],
      events: [],
    });
    const page = await service.buildTrace(1, QUERY);
    const run = page.runs[0];
    expect(run.segments).toHaveLength(1);
    expect(run.segments[0].kind).toBe('current');
    expect(run.segments[0].rounds).toHaveLength(1);
    expect(run.segments[0].rounds[0].createdAt).toBe('2026-10-09 10:00:30');
  });

  it('attaches compaction marker by boundary_msg_id only', async () => {
    const service = makeService({
      messages: [
        user(1, '2026-10-09 10:00:00', '第一轮'),
        assistant(2, '2026-10-09 10:00:05', []),
        user(3, '2026-10-09 10:01:00', '第二轮'),
      ],
      calls: [call(1, { createdAt: '2026-10-09 10:00:02' }), call(2, { id: 2, createdAt: '2026-10-09 10:01:02' })],
      activities: [],
      events: [
        { id: 1, sessionId: 1, triggerMode: 'mid_loop', prevBoundaryMsgId: 0, boundaryMsgId: 2, compactedMessageCount: 8, summaryTokens: 100, savedTokens: 2000, durationMs: 1500 },
        { id: 2, sessionId: 1, triggerMode: 'manual', prevBoundaryMsgId: 2, boundaryMsgId: 3, compactedMessageCount: 3, summaryTokens: 50, savedTokens: 800, durationMs: 900 },
      ],
    });
    const page = await service.buildTrace(1, QUERY);
    expect(page.runs.map((r) => r.runId)).toEqual([3, 1]);
    expect(page.runs[1].markers).toEqual([{ kind: 'compaction', atMessageId: 2, detail: 'mid_loop · 压缩 8 条消息 · 节省 2000 tokens' }]);
    expect(page.runs[0].markers).toEqual([{ kind: 'compaction', atMessageId: 3, detail: 'manual · 压缩 3 条消息 · 节省 800 tokens' }]);
  });

  it('collects subagent links from delegate results including failures', async () => {
    const service = makeService({
      messages: [
        user(1, '2026-10-09 10:00:00', '派个活'),
        assistant(2, '2026-10-09 10:00:05', [
          { id: 'tc1', name: 'delegate', args: '{"agent_type":"reviewer","task":"审查 diff"}' },
          { id: 'tc2', name: 'delegate_followup', args: '{"child_session_id":88,"task":"继续核查"}' },
          { id: 'tc3', name: 'shell', args: '{"command":"ls"}' },
        ]),
        toolMessage(3, '2026-10-09 10:00:06', 'tc1', JSON.stringify({ success: true, child_session_id: 42 })),
        toolMessage(4, '2026-10-09 10:00:06', 'tc2', JSON.stringify({ error: 'x', child_session_id: 88 })),
        toolMessage(5, '2026-10-09 10:00:06', 'tc3', '{"ok":true}'),
      ],
      calls: [call(1, { createdAt: '2026-10-09 10:00:02' })],
      activities: [],
      events: [],
    });
    const page = await service.buildTrace(1, QUERY);
    expect(page.runs[0].subagentLinks).toEqual([
      { sessionId: 42, title: '审查 diff' },
      { sessionId: 88, title: '继续核查' },
    ]);
  });

  it('omits subagent link when result has no child_session_id', async () => {
    const service = makeService({
      messages: [
        user(1, '2026-10-09 10:00:00', '派个活'),
        assistant(2, '2026-10-09 10:00:05', [{ id: 'tc1', name: 'delegate', args: '{"task":"x"}' }]),
        toolMessage(3, '2026-10-09 10:00:06', 'tc1', 'not-json'),
      ],
      calls: [call(1, { createdAt: '2026-10-09 10:00:02' })],
      activities: [],
      events: [],
    });
    const page = await service.buildTrace(1, QUERY);
    expect(page.runs[0].subagentLinks).toEqual([]);
  });

  it('puts pre-first-user-message calls into unattributed on the first page only', async () => {
    const service = makeService({
      messages: [user(5, '2026-10-09 10:00:00', '第一条')],
      calls: [
        call(1, { scene: 'session_title', createdAt: '2026-10-09 09:00:00', costMicros: 5 }),
        call(2, { createdAt: '2026-10-09 09:30:00' }),
        call(3, { id: 3, createdAt: '2026-10-09 10:00:02' }),
      ],
      activities: [
        activity(1, { createdAt: '2026-10-09 09:10:00', detailJson: null, summary: '早于会话的活动' }),
        activity(2, { createdAt: '2026-10-09 10:00:03', detailJson: null, summary: 'run 内活动' }),
      ],
      events: [],
    });
    const first = await service.buildTrace(1, QUERY);
    expect(first.unattributed).not.toBeNull();
    expect(first.unattributed!.rounds).toHaveLength(2);
    expect(first.unattributed!.rounds.map((r) => r.scene)).toEqual(['session_title', 'agent']);
    expect(first.unattributed!.tools.map((t) => t.name)).toEqual(['早于会话的活动']);
    expect(first.unattributed!.startedAt).toBe('2026-10-09T09:00');
    expect(first.unattributed!.endedAt).toBe('2026-10-09T09:30');
    // 最后一条用户消息之后的调用属于该 run，不是未归属
    expect(first.runs[0].segments[0].rounds).toHaveLength(1);
    expect(first.runs[0].segments[0].unplacedTools.map((t) => t.name)).toEqual(['run 内活动']);

    const second = await service.buildTrace(1, { ...QUERY, beforeRunId: 5 });
    expect(second.unattributed).toBeNull();
    expect(second.runs).toEqual([]);
    expect(second.hasMore).toBe(false);
  });

  it('returns null unattributed for sessions without stray calls', async () => {
    const service = makeService({
      messages: [user(1, '2026-10-09 10:00:00', '你好')],
      calls: [call(1, { createdAt: '2026-10-09 10:00:02' })],
      activities: [],
      events: [],
    });
    const page = await service.buildTrace(1, QUERY);
    expect(page.unattributed).toBeNull();
  });

  it('treats everything as unattributed when the session has no user message', async () => {
    const service = makeService({
      messages: [],
      calls: [call(1, { createdAt: '2026-10-09 09:00:00' })],
      activities: [activity(1, { createdAt: '2026-10-09 09:00:05', detailJson: null })],
      events: [],
    });
    const page = await service.buildTrace(1, QUERY);
    expect(page.runs).toEqual([]);
    expect(page.unattributed?.rounds).toHaveLength(1);
    expect(page.unattributed?.tools).toHaveLength(1);
  });

  it('pages runs without overlap and reports hasMore per page', async () => {
    const messages: Array<Message & { id: number }> = [];
    const calls: Array<LlmCallRow & { id: number }> = [];
    for (let i = 1; i <= 7; i++) {
      const id = i * 10;
      messages.push(user(id, `2026-10-09 10:0${i}:00`, `第${i}条`));
      calls.push(call(i, { createdAt: `2026-10-09 10:0${i}:05` }));
    }
    const service = makeService({ messages, calls, activities: [], events: [] });
    const page1 = await service.buildTrace(1, { ...QUERY, limit: 3 });
    expect(page1.runs.map((r) => r.runId)).toEqual([70, 60, 50]);
    expect(page1.hasMore).toBe(true);
    const page2 = await service.buildTrace(1, { ...QUERY, limit: 3, beforeRunId: 50 });
    expect(page2.runs.map((r) => r.runId)).toEqual([40, 30, 20]);
    expect(page2.hasMore).toBe(true);
    const page3 = await service.buildTrace(1, { ...QUERY, limit: 3, beforeRunId: 20 });
    expect(page3.runs.map((r) => r.runId)).toEqual([10]);
    expect(page3.hasMore).toBe(false);
    // 第二页起不再返回未归属
    expect(page2.unattributed).toBeNull();
  });

  it('marks slow and expensive at the exact threshold boundaries', async () => {
    const service = makeService({
      messages: [user(1, '2026-10-09 10:00:00', '你好')],
      calls: [
        call(1, { createdAt: '2026-10-09 10:00:02', durationMs: 60_000, promptTokens: 49_999, completionTokens: 1, cachedTokens: 0, cacheCreationTokens: 0, costMicros: null }),
        call(2, { id: 2, createdAt: '2026-10-09 10:01:00', durationMs: 59_999, promptTokens: 50_000, completionTokens: 0, cachedTokens: 0, cacheCreationTokens: 0 }),
      ],
      activities: [],
      events: [],
    });
    const page = await service.buildTrace(1, QUERY);
    const rounds = page.runs[0].segments[0].rounds;
    expect(rounds[0].slow).toBe(true);
    expect(rounds[0].expensive).toBe(true);
    expect(rounds[0].costMicros).toBeNull();
    expect(rounds[1].slow).toBe(false);
    expect(rounds[1].expensive).toBe(true);
  });

  it('counts cache creation tokens separately and keeps them in expensive check', async () => {
    const service = makeService({
      messages: [user(1, '2026-10-09 10:00:00', '你好')],
      calls: [call(1, { createdAt: '2026-10-09 10:00:02', promptTokens: 0, completionTokens: 0, cachedTokens: 30_000, cacheCreationTokens: 20_000 })],
      activities: [],
      events: [],
    });
    const page = await service.buildTrace(1, QUERY);
    const run = page.runs[0];
    expect(run.totals.cacheCreationTokens).toBe(20_000);
    expect(run.segments[0].rounds[0].expensive).toBe(true);
  });

  it('prefers approval mark from tool message metadata over activity detail', async () => {
    const service = makeService({
      messages: [
        user(1, '2026-10-09 10:00:00', '跑'),
        assistant(2, '2026-10-09 10:00:05', [{ id: 'tc1', name: 'shell', args: '{"command":"ls"}' }]),
        toolMessage(3, '2026-10-09 10:00:06', 'tc1', '{"ok":true}', JSON.stringify({ approvalMark: { mode: 'rule', approved: true, reason: 'r' } })),
      ],
      calls: [call(1, { createdAt: '2026-10-09 10:00:02' })],
      activities: [activity(1, { detailJson: JSON.stringify({ toolCallId: 'tc1', approvalMark: { mode: 'llm', approved: false } }) })],
      events: [],
    });
    const page = await service.buildTrace(1, QUERY);
    expect(page.runs[0].segments[0].rounds[0].tools[0].approvalMark).toBe('规则放行');
  });

  it('falls back to activity detail approval mark when metadata has none', async () => {
    const service = makeService({
      messages: [
        user(1, '2026-10-09 10:00:00', '跑'),
        assistant(2, '2026-10-09 10:00:05', [{ id: 'tc1', name: 'shell', args: '{"command":"ls"}' }]),
        toolMessage(3, '2026-10-09 10:00:06', 'tc1', '{"ok":true}'),
      ],
      calls: [call(1, { createdAt: '2026-10-09 10:00:02' })],
      activities: [activity(1, { detailJson: JSON.stringify({ toolCallId: 'tc1', approvalMark: { mode: 'llm', approved: false } }) })],
      events: [],
    });
    const page = await service.buildTrace(1, QUERY);
    expect(page.runs[0].segments[0].rounds[0].tools[0].approvalMark).toBe('AI 已拒绝');
  });

  it('keeps null duration for historical activities', async () => {
    const service = makeService({
      messages: [
        user(1, '2026-10-09 10:00:00', '跑'),
        assistant(2, '2026-10-09 10:00:05', [{ id: 'tc1', name: 'shell', args: '{"command":"ls"}' }]),
        toolMessage(3, '2026-10-09 10:00:06', 'tc1', '{"ok":true}'),
      ],
      calls: [call(1, { createdAt: '2026-10-09 10:00:02' })],
      activities: [activity(1, { detailJson: JSON.stringify({ toolCallId: 'tc1' }), durationMs: null, status: 'ERROR' })],
      events: [],
    });
    const page = await service.buildTrace(1, QUERY);
    const tool = page.runs[0].segments[0].rounds[0].tools[0];
    expect(tool.durationMs).toBeNull();
    expect(tool.status).toBe('ERROR');
    // null duration 不影响成败计数
    expect(page.runs[0].totals.toolError).toBe(1);
    expect(page.runs[0].totals.toolSuccess).toBe(0);
  });

  it('exposes user message preview and run start time', async () => {
    const service = makeService({
      messages: [user(1, '2026-10-09 10:00:00', '  帮我\n看看  这个问题 ')],
      calls: [],
      activities: [],
      events: [],
    });
    const page = await service.buildTrace(1, QUERY);
    expect(page.runs[0].userMessagePreview).toBe('帮我 看看 这个问题');
    expect(page.runs[0].startedAt).toBe('2026-10-09T10:00');
  });

  it('truncates long previews and flattens multimodal content', async () => {
    const long = 'x'.repeat(120);
    const service = makeService({
      messages: [
        user(1, '2026-10-09 10:00:00', JSON.stringify([{ type: 'text', text: long }, { type: 'image_url', image_url: { url: 'u' } }])),
      ],
      calls: [],
      activities: [],
      events: [],
    });
    const page = await service.buildTrace(1, QUERY);
    expect(page.runs[0].userMessagePreview).toHaveLength(81);
    expect(page.runs[0].userMessagePreview.endsWith('…')).toBe(true);
  });
});
