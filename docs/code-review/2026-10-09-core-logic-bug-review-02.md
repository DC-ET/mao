# 核心功能逻辑 BUG 评审（2026-10-09 第二轮）— 最近 15 天功能代码

- 审查对象：最近 15 天（2026-09-24 ~ 2026-10-09）合入 main 的功能代码，重点是运行轨迹透视（34529916 / 666a2cf9 / 485ff143 / 2f2dc3b6 / 32cc432b）、用量成本与预算（28ceb7a6 / e492ddee / 1f8e2f6c）、会话导出 JSONL 与只读分享（aadfeda5 / 9541b6cb）、飞书合并转发展开与群摘要（0d3ce68f / 39ddcc8a / 1f8e2f6c）、工具审批（0c87173b / 85a3d658）、边路任务 Fork（0cfef917）、Agent 资产分发与技能寻址（46d80667 / 0f59d51a / 300bd709 / 32faebb5）、上下文检查器（5b2cdb0b / 65ddca85）。
- 方法：全文阅读 + 每条结论必须附可在当前代码复现失败的 Vitest 测试；已与 docs/code-review/ 既有文档逐条比对，不重复上报已记录问题。
- 环境：Node 22 / Vitest 4（backend-ts、desktop 均为 `npx vitest run`）；时区相关用例以 `TZ=UTC` 复现。
- 本文保留条目的测试为审查探针：按仓库惯例（见 2026-10-09-core-logic-bug-review-01.md 等）**跑完即删、不入库**，完整源码与失败输出已内嵌到各节，修复时可直接取用；未修改任何生产代码与既有测试。
- 复核（同日，对照当前源码）：初稿 10 条里保留 5 条。墙钟迟到采样、`formatMs` 进位、轨迹分页竞态、删除会话不清理 trace 缓存、预算月度时区，问题或过窄、或与既有设计一致、或重新打开页面即恢复，移出正榜，理由见文末。

## 结论表

| 编号 | 严重度 | 领域 | 问题 |
|---|---|---|---|
| BUG-1 | 高 | harness/core | 一条夹在后续消息中间的孤儿 TOOL 让会话压缩永久失效：`snapshotMessageIds` 含原始 id，`persistedMessages` 已丢掉该行，`isCompletePhysicalPrefix` 恒 false，边界永不推进；历史撑过压缩窗口后请求直接失败 |
| BUG-2 | 中 | session | `getMessagesByRounds` 按页归一化，把「id 大于本页最旧 USER」的补写 TOOL 当孤儿丢掉：桌面历史上翻、分享只读页、JSONL 导出都会静默少这条消息 |
| BUG-3 | 中 | feishu | 群聊溢出摘要的水位线会越过未富化（enrich_pending=1）的行：合并转发展开后的摘录对该群永久丢失，被摘要的反而是占位英文 |
| BUG-4 | 中 | session | fork 预览向上翻页把上一页首条消息又返回一遍（含边界上界 `selectRangeThrough`），与 /messages 排他口径不符，前端渲染重复历史 |
| BUG-5 | 中 | skill | 技能 Bundle 导出在同一用户多个 frontmatter 同名目录时静默导出首个目录，分发出错误技能内容 |

合计 **5 个**。另有 5 条初稿经复核移出（见文末），2 个候选与既有文档重复、1 个候选已被历史文档判定剔除。

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
3. 孤儿若是当前最后一条原始消息，`candidateBoundary` 落在它前面，这一轮检查可以放过，边界停在最后一条保留消息上。用户只要再发一条消息，孤儿就重新落入 `(oldBoundary, candidateBoundary]`，之后每次压缩都失败。
4. `newLastCompactedMessageId` 无法越过该孤儿 → 会话只增不减 → 压缩请求估算超过压缩模型窗口时抛 `CompactionContextOverflowException`。该异常在 `agent-loop.ts:501` 与 `harness-service.ts` 的 `buildContext` 被原样 rethrow，这一轮以及之后每一轮在进模型前就失败。
5. 窗口还装得下时，失败尝试已经完整调用并计费了摘要 LLM，边界却不动。

### 预期 vs 实际

- 预期：孤儿 TOOL 只是被归一化丢弃，不影响压缩边界推进（对照组见测试第 1 例）。
- 实际：孤儿 id 落在 `(oldBoundary, 最后一条保留消息]` 时压缩永远被拒；边界不动、LLM 反复计费，历史撑过压缩窗口后会话发消息即失败。

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

## BUG-2【中】按页归一化把跨页补写的 TOOL 当孤儿丢掉：历史上翻、分享、导出都少消息

### 位置

- `backend-ts/src/session/session.service.ts:1017`（`getMessagesByRounds` 内 `MessageHistoryNormalizer.normalizeEntities(raw, parseToolCallsJson)` 逐页执行）
- 归一化实现：`backend-ts/src/harness/core/message-history-normalizer.ts:10-28`
- 调用方都是按页归一化：桌面历史 `GET /v1/sessions/:id/messages`（`useChat.ts` / `SideChatPanel.vue` 的 `roundLimit=5`）、分享 `session-share.routes.ts` 默认 `roundLimit=5`、导出 `session-export.service.ts:48`（`roundLimit=50`）、管理后台同一接口

### 代码事实

`normalizeEntities` 逐页执行，凡本页找不到对应 ASSISTANT `tool_calls` 的 TOOL 消息即当孤儿丢弃。页的下界 `startId` 是本页最旧一条 USER。补写出来的 TOOL id 大于这条 USER，声明它的 ASSISTANT id 小于这条 USER，于是两页都看不见它：本页有 TOOL 没有 ASSISTANT，上一页 `id < nextBeforeMessageId` 又切不到这条 TOOL。

该数据形态是代码库自己生产的。`cleanupIncompleteTail` / `cleanupIncompleteTailAfterId`（`session.service.ts:1044-1078`，`harness-service.ts` 每次 `buildContext` 都会调后者）把缺失工具结果 `saveMessage` 到当时的末尾。主路径下，用户消息先落库，补写发生在这条用户消息之后，所以占位 TOOL 的 id 大于「补写那一轮」的 USER，小于更后面的消息。

### 触发链

1. 某一轮助手声明了工具调用，结果没落库（中断、崩溃）。
2. 下一次执行：用户消息已入库，`cleanupIncompleteTailAfterId` 把占位 TOOL 追加在它后面。
3. 从最新往前数，这条 USER 正好排在第 `roundLimit`、`2*roundLimit`… 位，于是它成为某一页的 `startId`。
4. 本页丢掉占位 TOOL，上一页又不包含它。桌面再向上翻、分享翻页、JSONL `loadAllMessages` 都走这条路径，头部 `messageCount` 跟着少。

全量 `getMessages` 先取整段再归一化，占位能配回 ASSISTANT，所以只有分页读会丢。会话不足一页（`hasMore=false`，下界是最早的 USER）时 ASSISTANT 和 TOOL 同页，不丢。下面的探针把占位 TOOL 放到很多轮之后，是同一条漏洞的更强形态，失败方式相同。

### 预期 vs 实际

- 预期：TOOL 与 ASSISTANT 同页时保留（对照组通过，丢失只发生在页边界把二者拆开时）。
- 实际：页边界拆开后，分享 13 条只见到 12 条；60 轮导出 179/180。生产里更常见的是占位紧挨下一条 USER，只要该 USER 成为某页最旧一条，同样丢掉。

### 影响

丢掉的是「该工具调用没有对应输出」的系统占位，不是用户原文。桌面历史上翻、分享页、JSONL 里，助手的 `tool_calls` 会失去配对结果。分享默认 5 轮一页，对话变长后会周期性对齐命中，不是一次性竞态。

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

## BUG-3【中】飞书溢出摘要水位线越过未富化行，合并转发展开摘录永久丢失

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

## BUG-4【中】fork 预览翻页把上一页首条消息重复返回，与 /messages 口径不符

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

## BUG-5【中】技能 Bundle 导出对重名技能静默导出首个目录

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

## 与既有审查文档的关系（不重复上报）

- **`RecordingLlmChatClient` 丢弃 usage**（`usage: null, costMicros: snapshotCostMicros(config, null)`，影响飞书摘要/连通性测试记账）：与 `2026-10-09-core-logic-bug-review-01.md` **BUG-4 同根因**（该文聚焦 model_id/成本无法归属，本次从「delegate 响应里的 usage 被硬编码丢弃」角度复现，结论一致），不重复计入正榜。
- **导出 200 页（10000 轮）静默截断**：与该文 **A-4** 重复（且该文已注明「自 Markdown 导出版本起未变，属遗留限制」），不重复计入。
- **话题溢出摘要串到群级上下文**：机制可复现，但 `2026-09-30-logic-bug-review-01.md` 附录 B 已记录并「应需求方判定剔除」，按要求留档不重复上报。

## 复核后移出正榜（问题在，但不值得单列修复）

- **迟到活动把 run 墙钟撑出时间窗**（初稿 BUG-2）。`buildRun` 确实把按 `tool_call_id` 归回来的活动原样送进 `wallClockMs`，设计 §5.2 写的是「窗口内」采样。但活动行 `created_at` 是插入时的 `CURRENT_TIMESTAMP`（`V010`），`onToolCallResult` 里 `void recordActivity` 在工具结束当刻就发起。正常路径下插入早于下一条用户消息；能落进下一 run 窗口的只是插入提交比下一条消息落库更晚的窄竞态，墙钟多出来的是这一段提交延迟，通常秒级，不是初稿里那 5 分钟。既有用例 `attributes late-inserted activity to the original run by tool_call_id` 也只锁归属、不锁墙钟。不单列。
- **`formatMs` 渲染 "1m 60s"**（初稿 BUG-5）。`RunTracePanel.vue` 的 `Math.round((ms % 60_000) / 1000)` 在 `[n 分 59.5 秒, n+1 分)` 这 500ms 里会得到 60，且不向分钟进位。纯展示，命中窗口很窄。
- **轨迹「加载更多」与执行结束重拉并发吞 run**（初稿 BUG-6）。`refetchLoadedPages` 不置 loading，`appendTracePage` 无条件拼接，初稿时序在代码上成立，列表会缺一条且 `hasMore` 可能被旧页写成 false。数据仍在服务端；轨迹 Tab 重挂载会 `loadFirstPage`。触发要赶在执行结束重拉尚未返回时去点「加载更多」。不单列。
- **删除会话不调 `clearTrace`**（初稿 BUG-9）。`purgeSessionRuntime` 确实没清 trace 域，`clearTrace` 全仓只有定义和导出。会话 id 自增，不复用；残留只在当前页面内存里，刷新即没。不单列。
- **预算月界用进程本地时区**（初稿 BUG-10）。`monthStartLocal` / `currentPeriodLabel` 用 `getFullYear()` / `getMonth()`，与 `docs/plan/2026-10-06-usage-cost-budget-technical-design.md` §5.6「服务器本地时区当月 1 日」一致。`2026-10-08-usage-cost-budget-round1-p2-budget.md` 已因此不计 BUG。DB 会话固定 `+08:00`，只有进程不是 +08:00 才和库内墙钟错开；即便进程是 UTC，整月窗口回退也只发生在北京时间已经翻月、UTC 还停在上月的那 8 小时，不是整月都错。`scripts/start-backend.sh` 不改 TZ，跟随宿主。不单列。

## 排查过但确认「不是 BUG」的区域（避免重复投入）

- **运行轨迹**：跨页归属与去重（2f2dc3b6 修复正确）、分页边界（limit 钳位、越界游标、limit+1 锚点）、软删过滤、负 duration 归零、并发/乱序事件、统计口径与展示口径一致性、admin 聚合 SQL。墙钟迟到采样与加载竞态见上一节，不进正榜。
- **飞书合并转发展开核心**：递归深度/死循环（自引用、循环引用、菱形重复）、顺序稳定、重复展开、发送人识别、白名单外类型降级、时间格式、@ 判断、摘要 prompt 分置——无问题（BUG-3 是水位线/溢出查询层，与展开核心无关）。
- **工具审批**：SESSION 作用域不泄漏、持久放行名单匹配（词边界）、denylist 匹配时全命令扫描、hint 恰好一次消费——无问题。
- **用量计价**：`cost-micros` 四项计价与取整、缺失价格兜底、三个 LLM 适配器缓存 token 归因、`normalizePrice` 校验、V141 迁移公式——无问题。
- **上下文检查器**：容量分母同源、百分比钳制、分区加总——无问题（除既有文档已记录项）。
- **技能寻址 / 资产分发**：folderPath 精确寻址、409 失败闭合、bundle 哈希与版本比较、URL 导入限制、依赖补装——除 BUG-5 外无新问题。
- **JSONL 行结构**：特殊字符转义、压缩归档与导出行结构一致、分享过期等号边界、文件名截断——无问题（BUG-2 是翻页归一化层，与行结构无关）。

## 回归影响

正榜 5 条的探针仍是独立新文件，未改生产代码与既有测试，跑完已从工作区删除。初稿曾把桌面 `formatMs`、轨迹分页竞态、trace 缓存三支探针的失败算进回归数字；复核后这三条移出正榜，那些失败不再作为本文要修的问题。保留条目的探针源码与失败输出仍在各节，修复时按节重建即可。
