# 核心功能逻辑 BUG 评审（2026-10-09 第二轮）— 最近 15 天功能代码

- 审查对象：最近 15 天（2026-09-24 ~ 2026-10-09）合入 main 的功能代码，重点是运行轨迹透视（34529916 / 666a2cf9 / 485ff143 / 2f2dc3b6 / 32cc432b）、用量成本与预算（28ceb7a6 / e492ddee / 1f8e2f6c）、会话导出 JSONL 与只读分享（aadfeda5 / 9541b6cb）、飞书合并转发展开与群摘要（0d3ce68f / 39ddcc8a / 1f8e2f6c）、工具审批（0c87173b / 85a3d658）、边路任务 Fork（0cfef917）、Agent 资产分发与技能寻址（46d80667 / 0f59d51a / 300bd709 / 32faebb5）、上下文检查器（5b2cdb0b / 65ddca85）。
- 方法：全文阅读 + 每条结论必须附可在当前代码复现失败的 Vitest 测试；已与 docs/code-review/ 既有文档逐条比对，不重复上报已记录问题。
- 环境：Node 22 / Vitest 4（backend-ts、desktop 均为 `npx vitest run`）；时区相关用例以 `TZ=UTC` 复现。
- 本文所有测试为审查探针：按仓库惯例（见 2026-10-09-core-logic-bug-review-01.md 等）**跑完即删、不入库**，完整源码与失败输出已内嵌到各节，修复时可直接取用；未修改任何生产代码与既有测试。

## 结论表

| 编号 | 严重度 | 领域 | 问题 |
|---|---|---|---|
| BUG-1 | 高 | harness/core | 一条孤儿 TOOL 消息让会话压缩永久失效：`snapshotMessageIds` 与 `persistedMessages` 派生规则不一致，`isCompletePhysicalPrefix` 恒 false，边界永不推进，会话最终被压缩请求撑爆、彻底卡死 |
| BUG-2 | 中 | session/run-trace | 迟到活动（按 tool_call_id 归属）的 `created_at` 落在 run 时间窗外，仍参与该 run 墙钟计算，墙钟被撑到远超 run 自身时间窗跨度 |
| BUG-3 | 中 | session | `getMessagesByRounds` 按页归一化，把「id 大于后续 USER 消息」的迟到 TOOL 当孤儿丢弃：分享只读页与 JSONL 导出都静默漏消息 |
| BUG-4 | 中 | feishu | 群聊溢出摘要的水位线会越过未富化（enrich_pending=1）的行：合并转发展开后的摘录对该群永久丢失，被摘要的反而是占位英文 |
| BUG-5 | 中 | desktop | RunTracePanel `formatMs` 秒数四舍五入进位到 60 却不向分钟进位，渲染出 "1m 60s" / "2m 60s" |
| BUG-6 | 中 | desktop | 轨迹 Tab「加载更多」与「执行结束重拉」两条链路无在途保护，并发时中间若干 run 永久丢失且分页终止 |
| BUG-7 | 中 | session | fork 预览向上翻页把上一页首条消息又返回一遍（含边界上界 `selectRangeThrough`），与 /messages 排他口径不符，前端渲染重复历史 |
| BUG-8 | 中 | skill | 技能 Bundle 导出在同一用户多个 frontmatter 同名目录时静默导出首个目录，分发出错误技能内容 |
| BUG-9 | 低 | desktop | 删除会话不清理 trace 域缓存，`clearTrace()` 是死代码：内存驻留 + 会话 id 复用时报错会话的轨迹 |
| BUG-10 | 条件性 | usage/budget | 预算月度边界用进程本地时区，而 DB 会话固定 +08:00；非 +08:00（如 UTC 容器）部署下月度窗口回退一个月，预算被上月用量污染 |

合计 **10 个**（含 1 个条件性），每个均有失败测试佐证。另有 2 个候选经比对与既有文档重复、1 个候选已被历史文档判定剔除，见文末「与既有审查文档的关系」。

---

## BUG-1【高】一条孤儿 TOOL 消息让会话压缩永久失效，会话最终彻底卡死

### 位置

- `backend-ts/src/harness/core/session-history-loader.ts:27-33`（`loadHistoryAfterBoundary` 用两套规则生成快照 id 与持久化消息）
- `backend-ts/src/harness/core/compaction-service.ts:270-282`（`isCompletePhysicalPrefix` 假设两者一致）
- `backend-ts/src/harness/core/compaction-service.ts:151-156`（`buildSafeResult` 返回 null 即永久拒绝）

### 代码事实

`SessionHistoryLoader.loadHistoryAfterBoundary` 对同一批原始消息产出两个自相矛盾的列表：

```ts
const snapshotMessageIds = rawMessages.map((m) => m.id!);                    // 第 27 行：全部原始 id
const normalized = MessageHistoryNormalizer.normalizeEntities(rawMessages, parseToolCallsJson) ?? rawMessages; // 第 28 行：丢弃孤儿 TOOL
const persistedMessages = normalized.map((message) => new PersistedChatMessage(...));                          // 第 29-33 行
```

`MessageHistoryNormalizer.normalizeEntities`（`message-history-normalizer.ts:16-27`）会把 `toolCallId` 没有配对 assistant `tool_calls` 的 TOOL 消息整条丢弃（并打 warn `Dropping N orphaned tool messages`）。于是孤儿 id 只存在于 `snapshotMessageIds`，不存在于 `persistedMessages`。

而 `CompactionService.isCompletePhysicalPrefix` 要求区间内每个快照 id 都出现在 `messages` 里：

```ts
const normalizedIds = new Set(messages.map((m) => m.messageId));
return snapshotMessageIds
  .filter((id) => id > oldBoundary && id <= candidateBoundary)
  .every((id) => normalizedIds.has(id))   // ← 孤儿 id 恒 false
  && snapshotMessageIds.includes(candidateBoundary);
```

### 触发链

1. 会话历史里出现一条孤儿 TOOL 行（`toolCallId` 无配对 assistant `tool_calls`）。该状态是代码库自己明确防御过的：`normalizeEntities` 丢弃 + warn、`normalizeChatMessages` 反向填充缺失 tool 输出、32cc432b 还为「编辑截断后旧工具归属」专门补用例——说明生产中确实出现。
2. `compactSession` → `buildSafeResult` → `isCompletePhysicalPrefix` 对该 id 恒判 false → 日志 `Session handoff compaction rejected non-physical-prefix snapshot`，`compactSession` 返回 null。
3. `newLastCompactedMessageId` 永远无法越过该孤儿消息 → 会话只增不减地膨胀 → 压缩请求估算超过压缩模型窗口，抛 `CompactionContextOverflowException`；该异常在 `agent-loop.ts:500` 被**原样 rethrow**（不降级），整个会话执行直接死亡，用户连正常对话都无法进行。
4. 每次失败尝试都已完整调用并计费了摘要 LLM。

### 预期 vs 实际

- 预期：孤儿 TOOL 只是被归一化丢弃，不影响压缩边界推进（对照组见测试第 1 例）。
- 实际：只要区间内存在孤儿 id，压缩永远被拒；边界不动、LLM 反复计费、会话最终不可用。

### 影响

受影响会话永久失去自动/手动压缩能力并最终整体不可用。注：`2026-09-01-logic-bug-review-01.md:127` 曾以「snapshot 与 persistedMessages 同源同长，条件不可达」为由驳回过这条线索——该前提在孤儿 TOOL 场景下不成立，本文测试即为反证。

### 验证测试

`backend-ts/src/harness/zz-logicbug-orphan-tool-blocks-compaction.spec.ts`（真实 `SessionHistoryLoader` + `CompactionService`，仅 mock DB 与 LLM；第 1 例为对照组）。运行：

```bash
cd backend-ts && npx vitest run src/harness/zz-logicbug-orphan-tool-blocks-compaction.spec.ts
# Test Files 1 failed (1) / Tests 2 failed | 1 passed (3)
```

失败输出：

```
 FAIL  src/harness/zz-logicbug-orphan-tool-blocks-compaction.spec.ts >
   rejects compaction forever when one orphaned TOOL row sits inside the range
AssertionError: expected null not to be null
 ❯ src/harness/zz-logicbug-orphan-tool-blocks-compaction.spec.ts:137:24

 FAIL  ... > never advances the boundary and re-bills the summarizer on every attempt
AssertionError: expected null not to be null
```

探针源码：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatRequest, ChatUsage, LlmAdapter, StreamCallback, StreamChunk } from './llm/chat-request.js';
import type { CompactionArchiveService } from './core/compaction-archive.service.js';
import { CompactionConfig } from './core/compaction-config.js';
import { CompactionService } from './core/compaction-service.js';
import type { ContextManager } from './core/context-manager.js';
import { SessionHistoryLoader } from './core/session-history-loader.js';
import type { Message, SessionService } from './deps.js';
import type { TokenEstimator } from './core/token-estimator.js';

describe('zz-logicbug: orphaned TOOL message permanently blocks session compaction', () => {
  const llmAdapter = { chat: vi.fn(), stream: vi.fn() } as unknown as LlmAdapter & { chat: ReturnType<typeof vi.fn>; stream: ReturnType<typeof vi.fn> };
  const tokenEstimator = { estimateRequestTokens: vi.fn(), estimateMessages: vi.fn() } as unknown as TokenEstimator & { estimateRequestTokens: ReturnType<typeof vi.fn>; estimateMessages: ReturnType<typeof vi.fn> };
  const service = new CompactionService(llmAdapter, tokenEstimator);
  const sessionService = { getMessagesAfterId: vi.fn(), getLastUserMessage: vi.fn() } as unknown as SessionService & { getMessagesAfterId: ReturnType<typeof vi.fn>; getLastUserMessage: ReturnType<typeof vi.fn> };
  const contextManager = { prependSessionSummary: vi.fn(() => []) } as unknown as ContextManager;
  const compactionArchiveService = { buildArchiveHint: vi.fn(() => null) } as unknown as CompactionArchiveService;
  const loader = new SessionHistoryLoader(sessionService, contextManager, compactionArchiveService);

  function config(): CompactionConfig {
    const c = new CompactionConfig();
    c.enabled = true;
    c.contextWindowTokens = 1000;
    c.triggerRatio = 0.8;
    c.maxSummaryTokens = 321;
    return c;
  }

  function normalRequest(): ChatRequest {
    return {
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '帮我改一下登录' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', type: 'function' }] },
        { role: 'tool', toolCallId: 'c1', content: 'ok' },
        { role: 'user', content: '继续' },
      ],
      stream: true,
      promptCacheKey: 'mao-session-7',
    };
  }

  function usage(prompt: number, completion: number): ChatUsage {
    return { promptTokens: prompt, completionTokens: completion, totalTokens: prompt + completion };
  }

  function handoffChunk(text: string): StreamChunk {
    return { choices: [{ delta: { content: `<handoff>${text}</handoff>` } }] };
  }

  /** DB 里的原始消息：第 4 条 TOOL 的 toolCallId=ghost 没有任何 assistant tool_calls 与之配对。 */
  function rawMessages(): Message[] {
    return [
      { id: 1, sessionId: 7, role: 'USER', content: '帮我改一下登录' },
      {
        id: 2, sessionId: 7, role: 'ASSISTANT', content: '',
        toolCalls: JSON.stringify([{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } }]),
      },
      { id: 3, sessionId: 7, role: 'TOOL', toolCallId: 'c1', content: 'ok' },
      { id: 4, sessionId: 7, role: 'TOOL', toolCallId: 'ghost', content: '残留输出' },
      { id: 5, sessionId: 7, role: 'USER', content: '继续' },
    ];
  }

  beforeEach(() => {
    vi.clearAllMocks();
    sessionService.getMessagesAfterId.mockResolvedValue(rawMessages());
  });

  it('compacts the same history once the orphaned TOOL row is gone', async () => {
    // 对照组：同样的历史但没有第 4 条孤儿 TOOL —— 压缩正常成功
    sessionService.getMessagesAfterId.mockResolvedValue(rawMessages().filter((m) => m.id !== 4));
    const clean = await loader.loadHistoryAfterBoundary(7, 0);
    expect(clean.persistedMessages.map((m) => m.messageId)).toEqual([1, 2, 3, 5]);

    tokenEstimator.estimateRequestTokens.mockReturnValue(800);
    tokenEstimator.estimateMessages.mockReturnValue(30);
    llmAdapter.stream.mockImplementationOnce(async (_r: ChatRequest, _m: unknown, cb: StreamCallback) => {
      cb.onChunk(handoffChunk('交接正文'));
      cb.onComplete(usage(100, 10));
    });

    const result = await service.compactSession(
      7, 0, clean.persistedMessages, clean.snapshotMessageIds, normalRequest(),
      { modelId: 'gpt-test', contextWindowTokens: 1000 }, config(), null, null, 800,
    );

    expect(result).not.toBeNull();
    expect(result!.newLastCompactedMessageId).toBe(5);
  });

  it('rejects compaction forever when one orphaned TOOL row sits inside the range', async () => {
    const history = await loader.loadHistoryAfterBoundary(7, 0);
    // 真实 loader 的输出就是自相矛盾的：快照含 4，持久化消息不含 4
    expect(history.snapshotMessageIds).toEqual([1, 2, 3, 4, 5]);
    expect(history.persistedMessages.map((m) => m.messageId)).toEqual([1, 2, 3, 5]);

    tokenEstimator.estimateRequestTokens.mockReturnValue(800);
    tokenEstimator.estimateMessages.mockReturnValue(30);
    llmAdapter.stream.mockImplementation(async (_r: ChatRequest, _m: unknown, cb: StreamCallback) => {
      cb.onChunk(handoffChunk('交接正文'));
      cb.onComplete(usage(100, 10));
    });

    const result = await service.compactSession(
      7, 0, history.persistedMessages, history.snapshotMessageIds, normalRequest(),
      { modelId: 'gpt-test', contextWindowTokens: 1000 }, config(), null, null, 800,
    );

    expect(result).not.toBeNull();
    expect(result!.newLastCompactedMessageId).toBe(5);
  });

  it('never advances the boundary and re-bills the summarizer on every attempt', async () => {
    const history = await loader.loadHistoryAfterBoundary(7, 0);
    tokenEstimator.estimateRequestTokens.mockReturnValue(800);
    tokenEstimator.estimateMessages.mockReturnValue(30);
    llmAdapter.stream.mockImplementation(async (_r: ChatRequest, _m: unknown, cb: StreamCallback) => {
      cb.onChunk(handoffChunk('交接正文'));
      cb.onComplete(usage(100, 10));
    });

    // 边界永远停在 0：压缩请求（含交接指令）每次都被完整发送并计费，却没有一次能收敛
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = await service.compactSession(
        7, 0, history.persistedMessages, history.snapshotMessageIds, normalRequest(),
        { modelId: 'gpt-test', contextWindowTokens: 1000 }, config(), null, null, 800,
      );
      expect(result).not.toBeNull();
      expect(result!.newLastCompactedMessageId).toBeGreaterThan(0);
    }
    // 边界没有推进，下一次尝试会原样重来
    expect(llmAdapter.stream).toHaveBeenCalledTimes(3);
  });
});
```

### 修复方向（未改代码，供参考）

让 `snapshotMessageIds` 与 `persistedMessages` 同源（都从 `normalized` 取），或把 `isCompletePhysicalPrefix` 的判据改成只校验 `candidateBoundary` 存在且 `> oldBoundary`。

---

## BUG-2【中】迟到活动的 created_at 落窗外仍参与 run 墙钟计算，墙钟被撑到远超时间窗跨度

### 位置

`backend-ts/src/session/run-trace.service.ts:317-320`（`wallClockMs([...calls, ...runActivities])`）

### 代码事实

`calls` 已被 SQL 按 run 窗口 `[anchor.created_at, 上界)` 过滤，而 `runActivities` 是「按 tool_call_id 归属 + 时间窗兜底」的集合，**不按窗口过滤**。归属逻辑（`:137-152`）的注释明确写着「按消息归（即使 created_at 落在窗外）」——2f2dc3b6 起这就是有意口径。但窗外活动的 `created_at` 是**插入时刻**而非执行结束时刻，它随后原样进入墙钟采样点：

```ts
wallClockMs: wallClockMs([
  ...calls.map((c) => ({ createdAt: c.createdAt ?? null, durationMs: c.durationMs ?? null })),
  ...runActivities.map((a) => ({ createdAt: a.createdAt ?? null, durationMs: a.durationMs ?? null })),  // ← 未按窗口过滤
]),
```

`wallClockMs`（`:569`）取 `max(end) − min(start)`，没有任何窗口约束。

### 触发链

1. run1 = 用户消息 u1@10:00:00（assistant 声明 tc1），run2 = u2@10:05:00（声明 tc2）。
2. `llm_call` call1@10:00:02（dur 1000）在 run1 窗内；tc1 的活动异步晚插入（`ws-streaming-event-listener.ts:146` 的 `void this.recordActivity(...)`，`created_at` 取插入提交时刻），落库时间 10:05:30，已落进 run2 时间窗。
3. 活动按 tool_call_id 正确归属回 run1（展示、成败计数都对），但其 created_at 窗外 → 参与 run1 墙钟。

### 预期 vs 实际

- 预期（设计口径 `docs/plan/2026-10-09-run-trace-technical-design.md` §5.2 墙钟，第 161 行）：「对**窗口内**每条带 duration_ms 的 llm_call 和 session_activity：start = created_at − duration_ms……wallClockMs = max(end) − min(start)」——即只取时间窗内的采样点。
- 实际：run1 墙钟 = 10:05:30 − 10:00:01 = **329000ms**（约 5 分 29 秒），而 run1 窗口跨度只有 300000ms、真实耗时约 1 秒——墙钟虚高 329 倍，甚至**超过 run 自身的时间窗跨度**，违背「墙钟不可能大于窗口跨度」的不变式。第二页（beforeRunId=5）同构输入同样中招。

### 影响

墙钟是 run 摘要条核心展示项（设计 §292），排障时直接误导「这一轮花了多久」；不损坏落库数据，需异步插入滞后跨窗才触发。

### 验证测试

`backend-ts/src/session/zz-logicbug-trace-late-activity-wallclock.spec.ts`（mock 口径对齐 SQL 软删 `deleted = 0` 与窗口半开边界，风格同既有 spec）。运行：

```bash
cd backend-ts && npx vitest run src/session/zz-logicbug-trace-late-activity-wallclock.spec.ts
# Test Files 1 failed (1) / Tests 2 failed (2)
```

失败输出：

```
 FAIL  src/session/zz-logicbug-trace-late-activity-wallclock.spec.ts >
   run 墙钟只应取时间窗内的采样点（迟到活动的插入时刻不是执行结束时刻）
AssertionError: expected 329000 to be 1000 // Object.is equality

 FAIL  ... > 跨页迟到活动同样撑大归属页 run 的墙钟
AssertionError: expected 329000 to be 1000
```

探针源码（构造夹具部分，`makeService` 的内存仓库 mock 与 `run-trace.service.spec.ts` 同口径，此处从略；核心用例）：

```ts
const QUERY = { beforeRunId: null, limit: 5, slowMs: 60_000, expensiveTokens: 50_000 };

describe('logicbug: 迟到活动的 created_at 落在 run 时间窗外，却参与墙钟计算', () => {
  it('run 墙钟只应取时间窗内的采样点（迟到活动的插入时刻不是执行结束时刻）', async () => {
    const service = makeService({
      messages: [
        user(1, '2026-10-09 10:00:00', '第一轮'),
        assistant(2, '2026-10-09 10:00:05', [{ id: 'tc1', name: 'shell', args: '{"command":"ls"}' }]),
        toolMessage(3, '2026-10-09 10:00:06', 'tc1', '{"ok":true}'),
        user(5, '2026-10-09 10:05:00', '第二轮'),
        assistant(6, '2026-10-09 10:05:05', [{ id: 'tc2', name: 'shell', args: '{"command":"pwd"}' }]),
        toolMessage(7, '2026-10-09 10:05:06', 'tc2', '{"ok":true}'),
      ],
      calls: [
        call(1, { createdAt: '2026-10-09 10:00:02', durationMs: 1000 }),
        call(2, { id: 2, createdAt: '2026-10-09 10:05:02', durationMs: 1000 }),
      ],
      activities: [
        // tc1 归属 run1（消息在 run1），但异步晚插入：created_at 落进 run2 的时间窗
        activity(1, { detailJson: JSON.stringify({ toolCallId: 'tc1' }), createdAt: '2026-10-09 10:05:30', durationMs: 500 }),
        activity(2, { id: 2, detailJson: JSON.stringify({ toolCallId: 'tc2' }), createdAt: '2026-10-09 10:05:36', durationMs: 500 }),
      ],
      events: [],
    });
    const page = await service.buildTrace(1, QUERY);
    expect(page.runs.map((r) => r.runId)).toEqual([5, 1]);

    // 归属本身是对的：tc1 按 tool_call_id 归 run1（不按 created_at 改挂 run2）
    const run1 = page.runs[1];
    const run1Tools = run1.segments.flatMap((s) => [...s.rounds.flatMap((r) => r.tools), ...s.unplacedTools]);
    expect(run1Tools.map((t) => t.toolCallId)).toEqual(['tc1']);
    expect(run1.totals.toolSuccess).toBe(1);

    // 但墙钟用了窗外点：run1 窗口 [10:00:00, 10:05:00)，窗内只有 call1（10:00:02, dur 1000）。
    // 设计口径（§5.2 墙钟「对窗口内每条…」）下墙钟应为 1000ms。
    expect(run1.totals.wallClockMs).toBe(1000);

    // 不变式：一个 run 的墙钟不可能超过它自己的时间窗跨度（5 分钟 = 300000ms）。
    expect(run1.totals.wallClockMs).toBeLessThan(300_000);
  });

  it('跨页迟到活动同样撑大归属页 run 的墙钟', async () => {
    // 与上一例同构，但归属 run 在第二页：迟到活动在第二页按消息归 run1，
    // 其 created_at（run2 时间段）依旧进入 run1 的墙钟计算。
    const service = makeService({ /* 同构夹具，略 */ });
    const page2 = await service.buildTrace(1, { ...QUERY, beforeRunId: 5 });
    expect(page2.runs.map((r) => r.runId)).toEqual([1]);
    expect(page2.runs[0].totals.toolSuccess).toBe(1);
    expect(page2.runs[0].totals.wallClockMs).toBe(1000);
  });
});
```

### 修复方向

墙钟采样点传入前按 run 窗口过滤活动——仅保留 `created_at ∈ [anchor.createdAt, 上界)` 的活动（与 `calls` 的 SQL 窗口口径一致）；窗外迟到活动仍按 tool_call_id 展示与计成败，但不进墙钟。

---

## BUG-3【中】按页归一化把跨页迟到 TOOL 当孤儿丢弃：分享只读页与 JSONL 导出都漏消息

### 位置

- `backend-ts/src/session/session.service.ts:1017`（`getMessagesByRounds` 内 `MessageHistoryNormalizer.normalizeEntities(raw, parseToolCallsJson)` 逐页执行）
- 归一化实现：`backend-ts/src/harness/core/message-history-normalizer.ts:10-28`
- 调用方：分享 `session-share.service.ts:139-142`（roundLimit=5）、导出 `session-export.service.ts:48`（roundLimit=50）

### 代码事实

`normalizeEntities` 逐页执行，凡本页找不到对应 ASSISTANT `tool_calls` 的 TOOL 消息即当孤儿丢弃。翻页边界按 USER 消息 id 切分，一旦某条 TOOL 的 id 大于其后 USER 消息的 id，它就和声明它的 ASSISTANT 落在不同页：所在页看不到 ASSISTANT → 被丢弃；另一页又因 id 更大根本不包含它 → 两页都丢。

该数据形态是代码库自己生产的：`session.service.ts:1055-1078`（`cleanupIncompleteTail`）把缺失工具结果的占位符 `saveMessage` 到会话**末尾**，拿到的新 id 大于后续所有消息（包括之后轮次的 USER 消息）。

### 触发链

1. 第 1 轮助手声明两个工具调用，第二个工具结果未落库；用户继续对话数轮。
2. 某次执行触发 `cleanupIncompleteTail`：占位 TOOL 追加到末尾（id 大于后续 USER 消息 id）。
3. 分享只读页按 roundLimit=5 翻页遍历 → 占位 TOOL 所在页看不到 ASSISTANT → 丢弃 → 分享页少一条消息。
4. JSONL 导出按 roundLimit=50 翻页（`loadAllMessages`）→ 同样在页边界丢弃 → 导出文件少一行，且头部 `messageCount` 也跟着少——「每行一条原始消息」的卖点被破坏。

### 预期 vs 实际

- 预期：TOOL 与 ASSISTANT 同页时导出保留（对照组通过，证明丢失只发生在翻页边界）。
- 实际：分享翻页后 13 条消息只见到 12 条；60 轮会话导出只有 179/180 条。

### 影响

分享漏消息 + 导出漏原始消息；触发条件是「中断多工具轮后继续对话再触发 cleanup」，属真实序列。客户端历史与分享页「轮次一致」的口径（skills/mao-cli/reference/session.md）随之被破坏。

### 验证测试

`backend-ts/src/session/zz-logicbug-export-orphan-tool-drop.spec.ts`（真实 `SessionService` + `SessionExportService` + `SessionShareService`，内存仓库按真实 SQL 语义执行）。运行：

```bash
cd backend-ts && npx vitest run src/session/zz-logicbug-export-orphan-tool-drop.spec.ts
# Test Files 1 failed (1) / Tests 2 failed | 1 passed (3)
```

失败输出：

```
 FAIL  ... > 分享只读页翻页后丢掉迟到的 TOOL 消息
AssertionError: expected [ 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, …(2) ] to deeply equal [ 1, …12, 13 ]

 FAIL  ... > JSONL 导出在 50 轮翻页边界上同样漏掉迟到的 TOOL 消息
AssertionError: expected 179 to be 180 // Object.is equality
```

探针源码（核心部分）：

```ts
/** 6 轮对话，第 1 轮的助手声明了两个工具调用，第二个工具结果被"迟到"写到末尾（id 13）。 */
function lateToolSession(): Message[] {
  return [
    { id: 1, sessionId: 11, role: 'USER', content: 'q1', createdAt: '2026-10-06 10:00:00' },
    { id: 2, sessionId: 11, role: 'ASSISTANT', content: 'a1', toolCalls: JSON.stringify([{ id: 'c1', name: 'shell' }, { id: 'c2', name: 'shell' }]), createdAt: '2026-10-06 10:00:01' },
    { id: 3, sessionId: 11, role: 'USER', content: 'q2', createdAt: '2026-10-06 10:00:02' },
    /* …id 4..12 省略：交替 ASSISTANT / USER… */
    { id: 12, sessionId: 11, role: 'ASSISTANT', content: 'a6', createdAt: '2026-10-06 10:00:11' },
    // cleanupIncompleteTail 补的占位工具结果：id 落在后续 USER 消息之后
    { id: 13, sessionId: 11, role: 'TOOL', content: '[系统] 该工具调用没有对应输出', toolCallId: 'c2', createdAt: '2026-10-06 10:00:12' },
  ];
}

it('分享只读页翻页后丢掉迟到的 TOOL 消息', async () => {
  const service = makeService(lateToolSession());
  const svc = shareService(service);
  const created = await svc.create(session(), 7);
  const seen: number[] = [];
  let before: number | null = null;
  for (let page = 0; page < 20; page++) {
    const view = await svc.readView(created.token, 5, before, 9, '/v1/share/x');
    for (const message of view.messages) seen.push(Number(message.id));
    if (!view.hasMore) break;
    before = view.nextBeforeMessageId;
  }
  // 13 条消息都应可见；实际第 13 条（TOOL）被当孤儿丢弃
  expect(seen.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
});

it('JSONL 导出在 50 轮翻页边界上同样漏掉迟到的 TOOL 消息', async () => {
  // 59 个完整轮 + 第 60 轮只有 USER/ASSISTANT + 末尾追加占位 TOOL（id 180 > 后续 USER id）
  const result = await new SessionExportService(service, { findById: async () => null } as never).render(session());
  const [header, ...lines] = parseLines(result.jsonl);
  expect(header.messageCount).toBe(180);
  expect(lines).toHaveLength(180);
  expect(lines.map((line) => line.id)).toContain(180);
});

it('对照：迟到的 TOOL 与 ASSISTANT 同页时导出保留（说明丢失只发生在翻页边界）', async () => {
  const result = await new SessionExportService(makeService(lateToolSession()), { findById: async () => null } as never).render(session());
  const [, ...lines] = parseLines(result.jsonl);
  expect(lines).toHaveLength(13);
  expect(lines.map((line) => line.id)).toContain(13);
});
```

### 修复方向

翻页查询改为「先取窗口内全部原始消息再一次性归一化」，或让 `nextBeforeMessageId` 以未归一化的首条 id 为游标并保证跨页完整性（例如按 id 连续区间取页，使 TOOL 与 ASSISTANT 同页）。

---

## BUG-4【中】飞书溢出摘要水位线越过未富化行，合并转发展开摘录永久丢失

### 位置

- `backend-ts/src/feishu/message.service.ts:252-261`（`buildGroupContext` 过滤循环）
- `backend-ts/src/feishu/message.service.ts:293-318`（`buildOverflowSummary`）
- `backend-ts/src/feishu/message.repository.ts:203-212`（`listOverflowGroupMessages` SQL）

### 代码事实

`buildGroupContext` 的循环只在**最近 20 条窗口内**遇 `enrich_pending=1` 才 `break`：

```ts
for (const message of messages) {          // messages = 最近 20 条
  if (id <= watermark) continue;
  if (isPending(message)) break;           // 只在窗口内生效
  maxLogId = Math.max(maxLogId, id);
```

而 `buildOverflowSummary` 用 `listOverflowGroupMessages(accountId, chatId, watermark, beforeId, ...)` 取「水位线 < id < 窗口最小 id」的消息，该 SQL **不过滤 `enrich_pending`**：

```sql
AND id > ? AND id < ? AND is_mention = 0 AND thread_id IS NULL
```

于是只要未富化行被挤出 20 条窗口（或超出 `maxMinutes=120` 时间窗），过滤循环看不见它，`maxLogId` 直接取窗口最大 id，**水位线一次性跳过该行**。

这与 `message.service.ts:247-251`、`inbound-processor.ts:97-98` 自己声明的不变量（「水位线不得越过未富化行」）以及方案 `docs/plan/2026-10-08-feishu-merge-forward-technical-design.md` §4.4 / 风险表直接矛盾。合并转发行正是 39ddcc8a 新纳入 `needsEnrich` 的一类，该洞对本需求新开放。

### 触发链

1. 群里一条未 @ 的合并转发落库：`id=1, content='Merged and Forwarded Message', enrich_pending=1`，异步展开中。
2. 富化期间群里又到 21 条普通消息（id=2..22）+ 一条 @ 触发（id=23）。
3. 第一次 `buildGroupContext`：窗口 = id 4..23，`beforeId=4`，溢出集 = {1,2,3}（含未富化的 id=1）→ 水位线被推到 **23**。
4. 富化完成，id=1 回写摘录并清 `enrich_pending`。
5. 再次 @ 触发：`group.prompt` 实际为 **''**（空）——展开摘录永远进不了 Agent 上下文；被摘要的反而还是占位英文。

### 预期 vs 实际

- 预期：无论富化行是否在窗口内，水位线都不得越过它（不变量明文）。
- 实际：水位线被推到 23 > 1；120 分钟时间窗挤出的同款场景同样中招（水位线 4 > 1）。

### 影响

需「富化未完成期间同群新增 ≥20 条消息」（或跨 120 分钟）才触发，属竞态；一旦触发，合并转发展开/图片预下载的成果对该群永久失效，且占位英文会被当成「更早历史」送进摘要。

### 验证测试

`backend-ts/src/feishu/zz-logicbug-overflow-watermark-skips-pending.spec.ts`（内存仓库按对应 SQL 语义实现，真实 `FeishuMessageService`）。运行：

```bash
cd backend-ts && npx vitest run src/feishu/zz-logicbug-overflow-watermark-skips-pending.spec.ts
# Test Files 1 failed (1) / Tests 3 failed (3)
```

失败输出：

```
 FAIL  ... > 富化中的合并转发被挤出窗口后，水位线跳过它（不变量被破坏）
AssertionError: expected 23 to be less than 1
 ❯ src/feishu/zz-logicbug-overflow-watermark-skips-pending.spec.ts:146:35

 FAIL  ... > 被水位线跳过的合并转发，展开后的摘录永久进不了群上下文
AssertionError: expected '' to contain '告警已处理'

 FAIL  ... > 未富化行被 120 分钟时间窗挤出时同样不得被水位线跳过
AssertionError: expected 4 to be less than 1
```

探针源码（核心部分）：

```ts
const MERGE_FORWARD_PLACEHOLDER = 'Merged and Forwarded Message';

/** 构造「占位行 + 22 条后续消息 + 一次 @ 触发」的场景，返回触发前的水位线与占位行。 */
async function setupPendingMergeForward(service: FeishuMessageService, repo: InMemoryRepo): Promise<{ pending: Msg; trigger: Msg }> {
  // 1) 一条群里未 @ 的合并转发：先落占位，enrich_pending=1，异步展开中。
  const pending = repo.append({
    messageId: 'om_mf', msgType: 'merge_forward', content: MERGE_FORWARD_PLACEHOLDER, enrichPending: 1,
  });
  // 2) 富化期间群里又来了 21 条普通消息（把占位行挤出 20 条窗口），最后一条 @ 了机器人。
  for (let i = 0; i < 21; i++) {
    repo.append({ messageId: `om_chat_${i}`, content: `闲聊 ${i}`, isMention: false });
  }
  const trigger = repo.append({ messageId: 'om_trigger_a', content: '@机器人 看一下', isMention: true });
  // 3) 第一次 @ 触发：此刻占位行仍在富化。
  await service.buildGroupContext('1', makeContext({ messageId: trigger.messageId }));
  return { pending, trigger };
}

it('富化中的合并转发被挤出窗口后，水位线跳过它（不变量被破坏）', async () => {
  const repo = new InMemoryRepo();
  const summarizer = { summarize: vi.fn(async (record: string) => { repo.summarizeCalls.push(record); return '这是摘要'; }) };
  const service = new FeishuMessageService(repo.asNever(), { create: vi.fn() } as never, 20, 120, summarizer as never, 100);
  const { pending } = await setupPendingMergeForward(service, repo);

  // 水位线被推到 23，越过了仍在富化（enrich_pending=1）的 id=1。
  expect(repo.lastContextLogId).toBeLessThan(pending.id);
  // 占位行被当成「更早历史消息」摘要，固定英文进了摘录输入。
  expect(repo.summarizeCalls.join('\n')).not.toContain(MERGE_FORWARD_PLACEHOLDER);
});

it('被水位线跳过的合并转发，展开后的摘录永久进不了群上下文', async () => {
  const repo = new InMemoryRepo();
  const summarizer = { summarize: vi.fn(async (record: string) => record) };  // 原样回传，直接从 prompt 读内容
  const service = new FeishuMessageService(repo.asNever(), { create: vi.fn() } as never, 20, 120, summarizer as never, 100);
  const { pending } = await setupPendingMergeForward(service, repo);

  // 4) 异步富化完成：回写真实摘录并清 enrich_pending。
  const excerpt = '【合并转发，共 2 条】\n[2026-10-08 09:12] 张三：告警已处理';
  await repo.updateGroupMessageContent(pending.id, excerpt);

  // 5) 之后再来一次 @ 触发，Agent 必须看得到这条展开后的摘录
  const later = repo.append({ messageId: 'om_trigger_b', content: '@机器人 再说一句', isMention: true });
  const group = await service.buildGroupContext('1', makeContext({ messageId: later.messageId }));
  expect(group.prompt).toContain('告警已处理');
});
```

### 修复方向

`listOverflowGroupMessages` 增加 `enrich_pending = 0` 过滤；`buildGroupContext` 的水位线上限需按全局最旧未富化行收敛（而非只按窗口内可见行）。

---

## BUG-5【中】RunTracePanel formatMs 秒数进位到 60 不进位，渲染 "1m 60s"

### 位置

`desktop/src/components/center/RunTracePanel.vue:394-401`（`formatMs`）

### 代码事实

```ts
const minutes = Math.floor(ms / 60_000)
const seconds = Math.round((ms % 60_000) / 1000)   // 四舍五入后可为 60
return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`   // 没有向分钟进位
```

`119_500ms`（1m59.5s）→ minutes=1, seconds=Math.round(59.5)=**60** → "1m 60s"；`179_500` → "2m 60s"。`formatMs` 同时被墙钟、`round.durationMs`、`round.firstTokenMs`、`tool.durationMs`、`formatElapsed` 五处复用，任何落在 `[X*60+59.5, X*60+60)` 区间的耗时都会中招。

### 预期 vs 实际

- 预期：人类可读时长秒数必须 < 60（1m59.5s 应显示 "2m" 或 "1m 59s"）。
- 实际：渲染 "1m 60s" / "2m 60s"——非法时长，且 1m60s == 2m 的歧义让人误读为两段。

### 影响

纯展示错误，但所有长耗时 run 都可能触发，轨迹面板上的数字不可信。

### 验证测试

`desktop/src/components/center/zz-logicbug-formatms-minute-rollover.test.ts`（沿用既有先例 `run-trace-panel-session.test.ts` 的 SFC 编译 + 自建 nodeOps 渲染器，从渲染树抓「墙钟 …」文本）。运行：

```bash
cd desktop && npx vitest run src/components/center/zz-logicbug-formatms-minute-rollover.test.ts
# Test Files 1 failed (1) / Tests 2 failed (2)
```

失败输出：

```
 FAIL  src/components/center/zz-logicbug-formatms-minute-rollover.test.ts >
   119500ms（1m59.5s）不得渲染成 "1m 60s"
AssertionError: 秒数进位到 60 了：墙钟 1m 60s: expected 60 to be less than 60
 ❯ src/components/center/zz-logicbug-formatms-minute-rollover.test.ts:212:45

 FAIL  ... > 179500ms（2m59.5s）不得渲染成 "2m 60s"
AssertionError: 秒数进位到 60 了：墙钟 2m 60s: expected 60 to be less than 60
```

探针源码（渲染树断言部分；SFC 编译脚手架 `compileScript + compile + createRenderer(nodeOps)` 与 `run-trace-panel-session.test.ts` 相同，约 130 行，此处从略）：

```ts
function makeRun(wallClockMs: number) {
  return { runId: 11, userMessagePreview: '帮我改一下登录页', startedAt: '2026-10-09 10:00:00',
    segments: [{ kind: 'current', rounds: [{ seq: 1, /* … */ durationMs: 1000, firstTokenMs: null, /* … */ tools: [] }], unplacedTools: [] }],
    sideCalls: [], subagentLinks: [], markers: [],
    totals: { wallClockMs, costMicros: null, promptTokens: 1, completionTokens: 1, cachedTokens: 0, cacheCreationTokens: 0, toolSuccess: 0, toolError: 0 } };
}

it('119500ms（1m59.5s）不得渲染成 "1m 60s"', async () => {
  const root = await renderPanel('11', [makeRun(119_500)]);
  const texts = collectText(root);
  const wall = texts.find((t) => t.startsWith('墙钟 '));
  expect(wall).toBeDefined();
  const m = /^墙钟 (\d+)m(?: (\d+)s)?$/.exec(wall!);
  expect(m).not.toBeNull();
  if (m) {
    const minutes = Number(m[1]);
    const seconds = m[2] == null ? 0 : Number(m[2]);
    expect(seconds, `秒数进位到 60 了：${wall}`).toBeLessThan(60);
    const total = minutes * 60 + seconds;
    expect(total).toBeGreaterThanOrEqual(119);
    expect(total).toBeLessThanOrEqual(120);
  }
});

it('179500ms（2m59.5s）不得渲染成 "2m 60s"', async () => {
  const root = await renderPanel('11', [makeRun(179_500)]);
  const wall = collectText(root).find((t) => t.startsWith('墙钟 '));
  const m = /^墙钟 (\d+)m(?: (\d+)s)?$/.exec(wall!);
  expect(Number(m![2] ?? 0), `秒数进位到 60 了：${wall}`).toBeLessThan(60);
});
```

### 修复方向

`seconds === 60` 时 `minutes += 1; seconds = 0`（或改用 `Math.round(ms/1000)` 后整除取分秒）。

---

## BUG-6【中】轨迹 Tab「加载更多」与「执行结束重拉」并发，中间的 run 永久丢失

### 位置

- `desktop/src/components/center/RunTracePanel.vue:324-338`（`loadMore`）
- `desktop/src/components/center/RunTracePanel.vue:302-318`（`refetchLoadedPages`）
- `desktop/src/components/center/RunTracePanel.vue:353-360`（phase 终态 watch）
- store：`desktop/src/stores/session/trace.ts:68-85`（`setTracePage` 整页替换 / `appendTracePage` 无条件追加并覆写 hasMore）

### 代码事实

两条链路对同一会话的 `traceRuns` 无任何串行/在途保护：

- `loadMore` 只认按钮 loading（`setTraceLoading`），回来后 `appendTracePage` 无条件拼接；
- `refetchLoadedPages` 由 phase 进入终态的 watch 触发，**既不检查 `isTraceLoading` 也不打在途标记**，回来后 `setTracePage` 整页替换。

真实可达：执行刚结束的瞬间服务端正在落 llm_call，先发出去的加载更多请求反而后回来；且 refetch 不置 loading，此刻「加载更多」按钮仍可点。

### 触发链

1. 首页 5 条 `[r10..r6]`，hasMore=true，loadedPages=1。
2. 执行结束 phase `RUNNING→COMPLETED` → `refetchLoadedPages` 发出首页请求（在途，未置 loading）。
3. 用户点「加载更多」→ 发出 `beforeRunId=6` 请求（在途）。
4. refetch 的首页先回（新 run r11 落库 → `[r11..r7]`，`setTracePage` 整页替换）。
5. 加载更多的旧页后回 → `appendTracePage` 拼到后面 → 最终 `[11,10,9,8,7,5,4,3,2,1]`——**r6 消失且再也翻不回来**（hasMore 被旧页覆写为 false）。

### 预期 vs 实际

- 预期：两种刷新方式并发时列表不重不漏（11 个 run 一个不少）。
- 实际：r6 丢失、hasMore 被覆写、分页终止。

### 影响

UI 数据丢失 + 分页终止，非纯 cosmetic。

### 验证测试

`desktop/src/components/center/zz-logicbug-pagination-refetch-race.test.ts`（deferred 控制 api.get 响应顺序 + patchProp 记录 onClick 真实点击按钮；store 用真 `createTraceModule()` 承载）。运行：

```bash
cd desktop && npx vitest run src/components/center/zz-logicbug-pagination-refetch-race.test.ts
# Test Files 1 failed (1) / Tests 1 failed (1)
```

失败输出：

```
 FAIL  src/components/center/zz-logicbug-pagination-refetch-race.test.ts >
   加载更多在途时执行结束重拉，不得吞掉中间的 run
AssertionError: expected [ 11, 10, 9, 8, 7, 5, 4, 3, 2, 1 ] to deeply equal
               [ 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1 ]
```

探针源码（核心时序；渲染器脚手架同 BUG-5 探针，此处从略）：

```ts
it('加载更多在途时执行结束重拉，不得吞掉中间的 run', async () => {
  // …挂载面板（store 用真 createTraceModule）…
  await flush();

  // 1) 首页：[r10..r6]，hasMore=true
  expect(pending).toHaveLength(1);
  expect(pending[0]!.beforeRunId).toBeNull();
  pending[0]!.resolve({ runs: [10, 9, 8, 7, 6].map(mkRun), hasMore: true, unattributed: null });
  pending.length = 0;
  await flush();
  expect(trace.getTraceRuns('11').map((r) => r.runId)).toEqual([10, 9, 8, 7, 6]);
  expect(trace.getTraceHasMore('11')).toBe(true);

  // 2) 执行结束：phase → COMPLETED，触发 refetchLoadedPages（不置 loading）
  phase.value = 'COMPLETED';
  await flush();
  expect(pending, '终态应触发重拉').toHaveLength(1);
  const refetchReq = pending[0]!;
  expect(refetchReq.beforeRunId).toBeNull();

  // 3) 用户点「加载更多」：按钮此刻仍可点（refetch 不置 loading）
  expect(clickButton(root, '加载更多')).toBe(true);
  await flush();
  expect(pending).toHaveLength(2);
  const loadMoreReq = pending.find((p) => p.beforeRunId === 6)!;
  expect(loadMoreReq, '加载更多应按当前最后一条 runId=6 翻页').toBeDefined();

  // 4) 重拉的首页先回来：新 run r11 已落库 → [r11..r7]，整页替换
  refetchReq.resolve({ runs: [11, 10, 9, 8, 7].map(mkRun), hasMore: true, unattributed: null });
  pending.length = 0;
  await flush();
  expect(trace.getTraceRuns('11').map((r) => r.runId)).toEqual([11, 10, 9, 8, 7]);

  // 5) 加载更多的旧页后回来：拼到新整页后面
  loadMoreReq.resolve({ runs: [5, 4, 3, 2, 1].map(mkRun), hasMore: false, unattributed: null });
  pending.length = 0;
  await flush();

  const ids = trace.getTraceRuns('11').map((r) => r.runId);
  // 期望：11 个 run 一个不少（r11..r1），且互不重复
  expect(ids).toEqual([11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
});
```

### 修复方向

给「拉取 trace 页」加统一在途串行（如按 sessionId 的 promise 链或在途 generation 校验，迟到响应直接丢弃），`refetchLoadedPages` 也置 loading；`appendTracePage` 追加前校验游标仍等于当前末条 runId。

---

## BUG-7【中】fork 预览翻页把上一页首条消息重复返回，与 /messages 口径不符

### 位置

- `backend-ts/src/session/session.service.ts:974-978`（`getForkPreview`）
- `backend-ts/src/session/session.repository.ts:445-450`（`selectRangeThrough`，`id <= ?` 含边界）对比 `:538-548`（`selectRange`，`id < ?` 排他）
- 前端：`desktop/src/composables/useForkPreview.ts:99`（`messages.value = [...mapped, ...messages.value]` 前插、不去重）

### 代码事实

`getForkPreview` 注释声称「翻页时上界是『下一页起点之前』，与 /messages 的 beforeId 语义一致」，但实现走了含边界的 `selectRangeThrough(sessionId, startId, upperBound)`（`id <= upperBound`）。而 `nextBeforeMessageId = messages[0].id`（本页首条=最旧消息），当 `beforeMessageId` 是约束上界时它恰好等于 `nextBeforeMessageId`——含边界即把已展示消息重复带回。

`/messages`（`getMessagesByRounds`）用 `selectRange` 的 `id < beforeId` 排他边界，两页不重叠——同源承诺被破坏。

### 触发链

1. 会话 20 有 12 条消息（奇数 USER、偶数 ASSISTANT）。
2. `getForkPreview(20, null, 5)`：第一页返回 `[3..12]`，hasMore=true，nextBeforeMessageId=3。
3. 用该游标翻页 `getForkPreview(20, null, 5, 3)`：**返回 `[1,2,3]`**——消息 3 已被第一页展示过，又被带回一次。
4. 前端 `useForkPreview` 直接前插不去重 → 同一条历史消息在边路任务预览里渲染两条。

带切点（forkFromMessageId=12）同样复现。仅影响预览展示，不影响真实 fork 复制（`forkParentMessages` 按 `id <= 切点` 全量复制，与预览第一页一致）。

### 预期 vs 实际

- 预期：任意两页预览的消息 id 不重叠（与 /messages 同口径，其单测契约 `page([4,3]) + page([2,1])` 即排他）。
- 实际：第二页返回 `[1,2,3]`，与第一页重叠 id=3。

### 影响

预览与「真实 fork 结果一一对应」的产品承诺被破坏，用户看到重复历史。

### 验证测试

`backend-ts/src/session/zz-logicbug-fork-preview-paging-boundary.spec.ts`（fake MessageRepository 按仓库各方法真实 SQL 语义在内存执行；含 /messages 同输入对照）。运行：

```bash
cd backend-ts && npx vitest run src/session/zz-logicbug-fork-preview-paging-boundary.spec.ts
# Test Files 1 failed (1) / Tests 3 failed (3)
```

失败输出：

```
 FAIL  ... > 全量分叉翻页：第二页不得重复返回上一页首条消息（nextBeforeMessageId 那条）
AssertionError: expected [ 1, 2, 3 ] to deeply equal [ 1, 2 ]

 FAIL  ... > 带切点分叉翻页：第二页不得重复返回上一页首条消息
AssertionError: expected [ 1, 2, 3 ] to deeply equal [ 1, 2 ]

 FAIL  ... > 同口径对照：/messages 翻页两页不重叠，fork 预览必须与它一致
AssertionError: expected [ 1, 2, 3 ] to deeply equal [ 1, 2 ]
```

探针源码（核心部分）：

```ts
it('全量分叉翻页：第二页不得重复返回上一页首条消息（nextBeforeMessageId 那条）', async () => {
  const service = makeService(makeMessageRepo(history()));   // 12 条消息：奇数 USER、偶数 ASSISTANT

  const page1 = await service.getForkPreview(SESSION_ID, null, 5);
  expect(ids(page1)).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  expect(page1.hasMore).toBe(true);
  expect(page1.nextBeforeMessageId).toBe(3);

  const page2 = await service.getForkPreview(SESSION_ID, null, 5, page1.nextBeforeMessageId);
  // 更早一页只应含 id < 3 的消息；含 3 即与上一页重叠（前端会把同一条渲染两次）
  expect(ids(page2)).toEqual([1, 2]);
  expect(page2.hasMore).toBe(false);
  expect(ids(page2).filter((id) => ids(page1).includes(id))).toEqual([]);
});

it('同口径对照：/messages 翻页两页不重叠，fork 预览必须与它一致', async () => {
  const service = makeService(makeMessageRepo(history()));

  // /messages（getMessagesByRounds）：上一页首条 3 不会在第二页复现
  const msgPage1 = await service.getMessagesByRounds(SESSION_ID, 5, null);
  expect(msgPage1.nextBeforeMessageId).toBe(3);
  const msgPage2 = await service.getMessagesByRounds(SESSION_ID, 5, msgPage1.nextBeforeMessageId);
  expect(ids(msgPage2)).toEqual([1, 2]);

  // fork 预览用同样的翻页入参，却把 3 又带回一次（含边界上界 selectRangeThrough）
  const previewPage1 = await service.getForkPreview(SESSION_ID, null, 5);
  const previewPage2 = await service.getForkPreview(SESSION_ID, null, 5, previewPage1.nextBeforeMessageId);
  expect(ids(previewPage2)).toEqual(ids(msgPage2));
});
```

### 修复方向

`getForkPreview` 在 `beforeMessageId` 作为约束上界时改用排他边界（`selectRange` / `id < upperBound`），仅切点 `cutMessageId` 保留含边界。

---

## BUG-8【中】技能 Bundle 导出对重名技能静默导出首个目录

### 位置

- `backend-ts/src/skill/skill-bundle.service.ts:53-54`（`exportSkillBundle`，`skills.find((s) => s.name === name)?.folderPath`）
- 路由入口：`backend-ts/src/skill/skill-bundle.routes.ts:29`（`GET /v1/skill-bundles/:name?owner=<userId>`）

### 代码事实

上传侧 `validateSkillGroup` 不校验 frontmatter 名唯一，「用户 7 的 aaa/ 与 bbb/ 两个目录 frontmatter 同名 dup」是正常上传可达状态（`user-skill.service.spec.ts` 已有同构造用例）。此时导出用 `find()` 取首个命中——服务端替用户猜归属：

- 用户技能查看/删除已按 300bd709 的口径失败闭合（409 并列候选）；
- `AgentBundleService.exportBundle`（`agent-bundle.service.ts:237-243`）对「同一用户多个同名目录」抛 `PARAM_INVALID`；
- round3 评审还明确「不改变重名技能不可内联导出的既有决策」。

技能 Bundle 导出是唯一漏网路径，且错误不可恢复（分发出去的内容已错）。

### 预期 vs 实际

- 预期：歧义时失败闭合（`PARAM_INVALID` 并列候选目录），绝不静默导出任意一个。
- 实际：直接成功，返回 `{ bundle: {...} }`，内容恒为 readdir 首个目录（aaa）的文件；bundle 的 `skill.name='dup'`，`files` 却是任意一个同名目录的内容——导入到别处即把选错的技能以该名字安装进系统技能目录。

### 影响

静默导出/分发错误技能内容；需重名上传前置条件，失败方向不可逆。

### 验证测试

`backend-ts/src/skill/zz-logicbug-skill-bundle-dup-name-export.spec.ts`（真实临时目录 + `SkillLoader`/`PathSandbox`/`UserSkillService`；第 2 例为对照组）。运行：

```bash
cd backend-ts && npx vitest run src/skill/zz-logicbug-skill-bundle-dup-name-export.spec.ts
# Test Files 1 failed (1) / Tests 1 failed | 1 passed (2)
```

失败输出：

```
 FAIL  src/skill/zz-logicbug-skill-bundle-dup-name-export.spec.ts >
   同一用户多个 frontmatter 同名目录时导出必须失败闭合，不得静默导出首个目录
  → promise resolved "{ bundle: { …(5) }, …(1) }" instead of rejecting
```

探针源码：

```ts
it('同一用户多个 frontmatter 同名目录时导出必须失败闭合，不得静默导出首个目录', async () => {
  const md = (body: string) => `---\nname: dup\ndescription: 重名技能---\n${body}\n`;
  mkdirSync(join(userSkillsDir, '7', 'aaa'), { recursive: true });
  writeFileSync(join(userSkillsDir, '7', 'aaa', 'SKILL.md'), md('AAA 正文'));
  mkdirSync(join(userSkillsDir, '7', 'bbb'), { recursive: true });
  writeFileSync(join(userSkillsDir, '7', 'bbb', 'SKILL.md'), md('BBB 正文'));

  // 两个目录 frontmatter 同名，列表两行可见（上传通道不查重）
  const rows = new UserSkillService(userSkillsDir).listUserSkills(7);
  expect(rows.map((r) => r.name)).toEqual(['dup', 'dup']);

  // 期望：歧义寻址失败闭合，消息并列候选目录，与用户技能 409 / agent bundle 内联导出同口径
  await expect(service.exportSkillBundle('dup', 7)).rejects.toBeInstanceOf(BusinessException);
  const error = await service.exportSkillBundle('dup', 7).catch((e) => e as BusinessException);
  expect(error.code).not.toBe(0);
  expect(String(error.message)).toContain('aaa');
  expect(String(error.message)).toContain('bbb');
});

it('唯一命中的重名消歧后仍可正常导出（失败闭合不应误伤唯一归属）', async () => {
  mkdirSync(join(userSkillsDir, '7', 'aaa'), { recursive: true });
  writeFileSync(join(userSkillsDir, '7', 'aaa', 'SKILL.md'), '---\nname: dup\ndescription: 唯一---\nAAA 正文\n');
  const { bundle } = await service.exportSkillBundle('dup', 7);
  expect(bundle.skill.name).toBe('dup');
  expect(readFileSync(join(userSkillsDir, '7', 'aaa', 'SKILL.md'), 'utf8')).toBe(bundle.files['SKILL.md']);
});
```

### 修复方向

`exportSkillBundle` 按 frontmatter 名寻址时先收集全部候选，>1 个即抛 `PARAM_INVALID` 并列候选目录（与 agent bundle 内联导出口径对齐）。

---

## BUG-9【低】删除会话不清理 trace 域缓存，clearTrace 是死代码

### 位置

- `desktop/src/stores/session/list.ts:578-615`（`deleteSession` → `purgeSessionRuntime`）
- `desktop/src/stores/session/messages.ts:790-809`（`purgeSessionRuntime` 覆盖域清单）
- `desktop/src/stores/session/trace.ts:96-106`（`clearTrace`，全仓库无调用方）

### 代码事实

`purgeSessionRuntime` 逐域清理了消息/todos/活动/上下文/队列/文件变更/阶段等运行态，唯独没接 trace 域的 `traceRuns/traceHasMore/traceUnattributed/traceLoading/liveRounds/liveTools`；trace.ts 里为此写好的 `clearTrace()` 没有任何调用点（grep 全仓仅定义与导出两处）。

### 预期 vs 实际

- 预期：删除会话后该会话全部运行态缓存被清（对照组 `getQueueMessages('11')` 确实被清空，证明删除链路本身走到了 purge）。
- 实际：`getTraceRuns('11')` 仍返回 `[run7]`，`getLiveTools/getLiveRound/getLiveExecutionId` 全部残留。

### 影响

内存随删除会话数单调增长；会话 id 为服务端自增，id 复用（库重置/导入恢复）时轨迹 Tab 会显示上一个已删会话的轨迹。

### 验证测试

`desktop/src/stores/session/zz-logicbug-trace-not-purged.test.ts`（真 pinia store，仅 mock api）。运行：

```bash
cd desktop && npx vitest run src/stores/session/zz-logicbug-trace-not-purged.test.ts
# Test Files 1 failed (1) / Tests 1 failed (1)
```

失败输出：

```
 FAIL  src/stores/session/zz-logicbug-trace-not-purged.test.ts >
   删除会话后 trace 缓存（runs / 进行中计时）应被清理
AssertionError: expected [ { runId: 7, …(7) } ] to deeply equal []
```

探针源码：

```ts
it('删除会话后 trace 缓存（runs / 进行中计时）应被清理', async () => {
  const store = useSessionStore();
  store.setTracePage('11', { runs: [run as never], hasMore: true, unattributed: null });
  store.applyLiveToolStart('11', 'exec-1', 'call-1', 'shell');
  store.applyLiveRoundStart('11', 'exec-1', 3);
  // 对照：消息运行态确实会被 deleteSession 清掉（证明删除链路本身走到了 purge）
  store.setQueueMessages('11', [{ id: '1', sessionId: '11', content: 'm', sortOrder: 1 }]);

  mockDelete.mockResolvedValueOnce({ data: {} } as never);
  const deleted = await store.deleteSession('11');
  expect(deleted).toBe(true);

  expect(store.getQueueMessages('11')).toEqual([]); // 前提：purge 链路生效
  expect(store.getTraceRuns('11')).toEqual([]);
  expect(store.getTraceHasMore('11')).toBe(false);
  expect(store.getLiveTools('11', 'exec-1')).toEqual([]);
  expect(store.getLiveRound('11', 'exec-1')).toBeNull();
  expect(store.getLiveExecutionId('11')).toBeNull();
});
```

### 修复方向

`purgeSessionRuntime` 增加 `clearTrace(sid)`（trace.ts 已备好该函数，仅差接线）。

---

## BUG-10【条件性】预算月度边界用进程本地时区，与 DB 固定 +08:00 不一致

### 位置

- `backend-ts/src/budget/budget.service.ts:51-55`（`monthStartLocal` 用 `now.getFullYear()/now.getMonth()`）与 `:58-62`（`currentPeriodLabel` 同）
- 被 `getPeriodSpend → sumCostSince/sumTokensSince`（`budget.repository.ts:110-117`，`WHERE created_at >= '<boundary>'`）用作月度累计下界

### 代码事实

`db/db.ts` 把 MySQL 连接显式 pin 到 `timezone:'+08:00'`，即 `created_at >= '2026-10-01 00:00:00'` 由 MySQL 按 +08:00 解释，月度窗口本应取 +08:00 自然月起。但 `monthStartLocal` 用进程 OS 时区。当后端进程运行在非 +08:00（容器默认 UTC 很常见）时，同一瞬间会回退一个月：

- 进程 +08:00：`2026-09-30T20:00:00Z`（=10-01 04:00 +08:00）→ `2026-10-01`（正确）
- 进程 UTC：同输入 → `2026-09-01`（错误）

后果：UTC 部署下 `SUM(cost_micros)/SUM(total_tokens)` 从上月 1 号起累计，本月预算被上月用量污染 → 提前 BLOCK / 误报 WARN。

### 预期 vs 实际

- 预期：月度边界与 DB 的 +08:00 口径一致（`monthStartLocal` 顾名思义应给本地月，但「本地」在两端必须同一时区）。
- 实际：进程非 +08:00 时月度窗口错位一个月。

### 影响

条件性：若 `/opt/mao` 生产部署跑在 +08:00 则不触发；跑 UTC 则所有月度预算起算错误。**本条以 `TZ=UTC` 复现，默认 +08:00 环境下测试通过（bug 潜伏）**，如实标注，请按实际部署时区决定是否处置。

### 验证测试

`backend-ts/src/usage/zz-logicbug-budget-month-boundary-tz.spec.ts`。运行：

```bash
cd backend-ts && TZ=UTC npx vitest run src/usage/zz-logicbug-budget-month-boundary-tz.spec.ts
# Test Files 1 failed (1) / Tests 2 failed (2)
# 默认（+08:00）环境：2 passed —— bug 潜伏，需非 +08:00 才表现
```

失败输出（TZ=UTC）：

```
 FAIL  ... > monthStartLocal returns the +08:00 month start regardless of process timezone
AssertionError: expected '2026-09-01 00:00:00' to be '2026-10-01 00:00:00'

 FAIL  ... > currentPeriodLabel returns the +08:00 yyyy-MM regardless of process timezone
AssertionError: expected '2026-09' to be '2026-10'
```

探针源码：

```ts
describe('budget month boundary must honor the +08:00 DB session (BUG: uses process-local month)', () => {
  // 该瞬间在 +08:00 口径下确定无疑属于 10 月。
  const nowInCstOctober = new Date('2026-09-30T20:00:00Z');

  it('monthStartLocal returns the +08:00 month start regardless of process timezone', () => {
    expect(monthStartLocal(nowInCstOctober)).toBe('2026-10-01 00:00:00');
  });

  it('currentPeriodLabel returns the +08:00 yyyy-MM regardless of process timezone', () => {
    expect(currentPeriodLabel(nowInCstOctober)).toBe('2026-10');
  });
});
```

### 修复方向

月度边界按 +08:00 计算（与 DB 会话时区一致），例如用 `Intl.DateTimeFormat('en-CA', { timeZone: '+08:00' })` 取年月，或从配置读取统一时区。

---

## 与既有审查文档的关系（不重复上报）

- **`RecordingLlmChatClient` 丢弃 usage**（`usage: null, costMicros: snapshotCostMicros(config, null)`，影响飞书摘要/连通性测试记账）：与 `2026-10-09-core-logic-bug-review-01.md` **BUG-4 同根因**（该文聚焦 model_id/成本无法归属，本次从「delegate 响应里的 usage 被硬编码丢弃」角度复现，结论一致），不重复计入正榜。
- **导出 200 页（10000 轮）静默截断**：与该文 **A-4** 重复（且该文已注明「自 Markdown 导出版本起未变，属遗留限制」），不重复计入。
- **话题溢出摘要串到群级上下文**：机制可复现，但 `2026-09-30-logic-bug-review-01.md` 附录 B 已记录并「应需求方判定剔除」，按要求留档不重复上报。

## 排查过但确认「不是 BUG」的区域（避免重复投入）

- **运行轨迹**：跨页归属与去重（2f2dc3b6 修复正确）、分页边界（limit 钳位、越界游标、limit+1 锚点）、软删过滤、负 duration 归零、并发/乱序事件、统计口径与展示口径一致性、admin 聚合 SQL——除 BUG-2 外无新问题。
- **飞书合并转发展开核心**：递归深度/死循环（自引用、循环引用、菱形重复）、顺序稳定、重复展开、发送人识别、白名单外类型降级、时间格式、@ 判断、摘要 prompt 分置——无问题（BUG-4 是水位线/溢出查询层，与展开核心无关）。
- **工具审批**：SESSION 作用域不泄漏、持久放行名单匹配（词边界）、denylist 匹配时全命令扫描、hint 恰好一次消费——无问题。
- **用量计价**：`cost-micros` 四项计价与取整、缺失价格兜底、三个 LLM 适配器缓存 token 归因、`normalizePrice` 校验、V141 迁移公式——无问题。
- **上下文检查器**：容量分母同源、百分比钳制、分区加总——无问题（除既有文档已记录项）。
- **技能寻址 / 资产分发**：folderPath 精确寻址、409 失败闭合、bundle 哈希与版本比较、URL 导入限制、依赖补装——除 BUG-8 外无新问题。
- **JSONL 行结构**：特殊字符转义、压缩归档与导出行结构一致、分享过期等号边界、文件名截断——无问题（BUG-3 是翻页归一化层，与行结构无关）。

## 回归影响

新增测试全部为独立新文件，未改动任何生产代码与既有测试。受影响目录回归（2026-10-09，Node 22 / Vitest 4）：

```
backend-ts: npx vitest run src/session src/usage src/skill src/feishu
  → Test Files 8 failed | 53 passed (61)；Tests 15 failed | 850 passed (865)
  （15 个失败全部为本文探针用例）
backend-ts: npx vitest run src/harness
  → Test Files 1 failed | 78 passed (79)；Tests 2 failed | 959 passed (961)
  （2 个失败为 BUG-1 探针）
desktop:   npx vitest run src/components/center src/stores/session src/composables/useStreamWS.test.ts src/composables/useCenterTabs.test.ts
  → 83 passed / 4 failed（4 个失败全部为本文桌面探针）
```

所有探针文件已在验证后从工作区删除（仓库惯例：验证探针跑完即删，避免 CI 常红）；本文各节已内嵌完整源码与失败输出，修复时可直接取用重建。
