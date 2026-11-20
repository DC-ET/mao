# 核心功能逻辑 BUG 评审（2026-10-09）— 最近 7 天功能代码

- **日期**：2026-10-09
- **基线**：main @ `9ba70af6`（审查起点工作区干净），所有行号以当前源码实测核对。
- **范围**：2026-10-02 ~ 2026-10-09 的 74 个提交中的功能代码。重点覆盖：用量成本核算与四项计价（`28ceb7a6`、`e492ddee`）、会话导出 JSONL（`aadfeda5`）、context manifest 快照（`ac0da64b`）、压缩模型独立配置 P3（`28ceb7a6`）、待发送消息队列拖拽排序（`4b3aa658`）、边路任务 fork 与 Fork 预览（`0cfef917`、`0e40eff3`）、任务收件箱（`1e5d32a4`）、开放接口（`e2f65d7b`）、Agent 资产化（`f1a7075e`）、长期记忆（`1b869631`）、审批规则（`0c87173b`+修复）、WS 会话执行/队列消费链路（`c5c40294` 等）。`docs/`、`CHANGELOG.md`、`skills/` 未审。
- **方法**：六路并行分模块通读源码出题（用量计价 / 导出与 manifest / 队列与桌面 store / WS 与任务终态 / harness 引擎 / 桌面 UI），**正榜 8 条全部由本人逐条亲笔重写探针实跑复现**（探针只新建临时 spec 文件、跑完即删，未改动任何产品源码与既有 spec）；每条候选在入选前与 `docs/code-review/` 既有 300+ 篇文档逐条 grep 去重。另有 4 条子代理探针验证的附带发现列入附录 A（附完整探针代码与输出，本人未重跑）。
- **基线健康度**：`backend-ts` `npx vitest run src/session src/harness/core src/usage` → 41 files / 651 tests 全绿；`desktop` `npx vitest run src/components/chat src/stores` → 存量全绿（仅本文探针失败，即 BUG 复现本身）。
- **结论**：确认 **8 个可复现的核心功能逻辑 BUG**（3 高 / 5 中），全部附可运行探针源码与实测输出；附录 A 另有 4 个经子代理探针验证的附带发现（1 中 3 低）。

---

## 结论表

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| BUG-1 | 高 | session/ws | `handleInsertMessage` 早退分支永久泄漏 `suppressAutoConsumeSend`，该会话消息队列从此永不自动消费，重启才恢复 |
| BUG-2 | 高 | harness/core | 压缩触发阈值改用「压缩模型」的上下文窗口：窗口配大则自动压缩永不触发（直到爆窗），配小则过早触发并抛溢出异常直接中断执行 |
| BUG-3 | 高 | harness/core | 流式工具调用迟到真实 id 时 `onToolCallStart` 下发两次（合成 id + 真实 id），注册表留下永久孤儿调用，桌面端出现永不收结果的假卡且刷新后复活 |
| BUG-4 | 中 | usage/feishu | 飞书群聊溢出摘要的 llm_call 行 `model_id`/`cost_micros`/`total_tokens` 全丢（config 未带 `id`，兜底价格查询被跳过），成本永久无法归属 |
| BUG-5 | 中 | harness/session | context manifest 快照双写方均 fire-and-forget 无排队，乱序落库后 DB 回退到旧快照，刷新后上下文抽屉显示落后一轮的构成与 token |
| BUG-6 | 中 | usage/llm | 流式调用被上游中断（或用户取消）时丢弃已到达的 usage，llm_call 记 0 token / 0 成本，违反技术方案 §5.2「失败调用产生了 token 照常计价」 |
| BUG-7 | 中 | desktop/backend | 队列消息 id 在 REST（数字）与 WS（字符串）两条通道间类型不一致，`onDragEnd` 严格相等匹配必然 miss：队列由 REST 灌入（默认初始态）时拖拽排序 100% 静默失效 |
| BUG-8 | 中 | desktop | `SideChatPanel.loadSideSessionMeta` 迟到响应无 post-await 守卫，把来源会话的 phase 写进当前会话并覆写 `sending`（同文件姊妹函数刚修过同类问题） |

---

## BUG-1【高】`handleInsertMessage` 早退分支永久泄漏 `suppressAutoConsumeSend`，会话队列永不自动消费

### 位置

- `backend-ts/src/session/ws/streaming-ws-handler.ts:1566`（泄漏点 `add`）
- 早退分支：`:1574`（队列项非 PENDING）、`:1580`（abort 等待 30s 超时）、`:1591`（会话已被占用）、`:1597`（窗口期内取消）、`:1605`（二次校验已消费）
- 唯一三处回收：`:1639`、`:1676`（均在 `:1628` 开始的 try/finally 内）、`:1681`（仅捕获同步抛出）
- 消费闸门：`:1744`（`autoConsumeQueue` 命中即整个会话停摆）

### 代码事实

```ts
// :1566 进入 handleInsertMessage 立即登记抑制标记
this.suppressAutoConsumeSend.add(sessionId);
try {
  this.deps.agentExecutor(async () => {
    await this.withLock(this.insertLocks, sessionId, async () => {
      const item = await this.deps.messageQueueService.getById(queueId);
      if (!item || item.sessionId !== sessionId || item.status !== 'PENDING') {
        await this.sendQueueUpdated(sessionId, userId);
        return;                          // ← :1574 早退：suppress 未删
      }
      ...
      if (!(await this.awaitExecutionRelease(sessionId, 30_000))) { ...; return; }   // ← :1580
      if (this.executionClaims.has(sessionId)) { ...; return; }                      // ← :1591
      if (this.pendingCancels.delete(sessionId)) { ...; return; }                    // ← :1597
      { const latest = await ...getById(queueId); if (!latest || latest.status !== 'PENDING') { ...; return; } }  // ← :1605
      try {                     // ← :1628：finally 覆盖范围从此才开始
        ...
        this.suppressAutoConsumeSend.delete(sessionId);   // :1639
        ...
      } finally {
        this.suppressAutoConsumeSend.delete(sessionId);   // :1676
      }
    });
  });
} catch {
  this.suppressAutoConsumeSend.delete(sessionId);        // :1681（仅同步抛出）
}
```

```ts
// :1740-1744 autoConsumeQueue 的消费闸门
async autoConsumeQueue(sessionId: number, userId: number): Promise<void> {
  const queue = await this.deps.messageQueueService.listPending(sessionId);
  if (queue.length === 0) return;
  if (this.suppressAutoConsumeSend.has(sessionId)) return;   // ← 命中即整个会话停摆
```

### 触发链

1. 用户在桌面端对某队列消息点「立即发送」（`insert_message`）。正常链路 `:1639`/`:1676` 会摘除抑制标记；
2. 但若该队列项已被 autoConsume 消费（`status=DELETED`，如双击、auto-consume 500ms 窗口内的陈旧 UI 状态），或 abort 等待 30s 超时、或窗口期内点过「停止」、或并发下二次校验发现已消费——流程从 `:1574`/`:1580`/`:1591`/`:1597`/`:1605` 直接 return，**三处 delete 一个都不执行**；
3. `suppressAutoConsumeSend` 中该 sessionId 成为永久残留；
4. 此后该会话任何执行结束（`runExecution` finally `:749` `if (terminalPhase !== 'FAILED') await this.autoConsumeQueue(...)`）走到 `:1744` 一律早退——**队列里剩余的每条消息都永远不会被自动执行**，直到后端重启。

### 预期 vs 实际

- 预期：insert 无论走哪条出口都应回收抑制标记（与成功路径对称）；历史版本曾用包裹整个 withLock 体的 try/finally 覆盖全部早退分支。
- 实际：早退分支零回收，闸门永久拦截该会话的队列自动消费。

### 影响

单会话消息队列功能性停摆（用户看到消息永远排在队列里不动），无任何自愈路径（重启才恢复）；插入操作本身只是"静默无效"，无错误提示，易误判为前端卡死。

### 验证测试（探针，跑完即删）

`backend-ts/src/zz-verify-1-insert-suppress.spec.ts`（驱动真实 `StreamingWsHandler`，复刻既有 spec 的 CapturingExecutor + fake deps 风格）：

```ts
import { describe, expect, it, vi } from 'vitest';
import { StreamingWsHandler, type WsHandlerDeps } from './session/ws/streaming-ws-handler.js';
import type { Session } from './domain/types.js';
import type { WsSocket } from './session/ws/streaming-ws-registry.js';
import { StreamingWsRegistry, WS_OPEN } from './session/ws/streaming-ws-registry.js';
import { CompactionSignalBus } from './harness/core/compaction-signal-bus.js';

class CapturingExecutor {
  readonly tasks: Array<() => void | Promise<void>> = [];
  submit(fn: () => void | Promise<void>): unknown { this.tasks.push(fn); return fn; }
  async runAll(): Promise<void> {
    while (this.tasks.length > 0) { const fn = this.tasks.shift()!; await fn(); }
  }
}

function makeHarness(sessionId: number, userId: number) {
  const executor = new CapturingExecutor();
  const sessionRow: Session = {
    id: sessionId, userId, agentId: 5, executionMode: 'CLOUD', phase: 'IDLE',
    permissionLevel: 'READ_ONLY', status: 'ACTIVE',
  };
  const registry = {
    isConnectionAuthorized: vi.fn(() => true), sendToConnection: vi.fn(),
    closeConnection: vi.fn((socket: WsSocket, reason: string) => socket.close(1003, reason)),
    getUserId: vi.fn(() => userId), send: vi.fn(), subscribe: vi.fn(), unsubscribe: vi.fn(),
    register: vi.fn(), unregister: vi.fn(), hasLocalClientConnection: vi.fn(),
    sendToLocalClients: vi.fn(), getActiveToolCalls: vi.fn(() => []), clearActiveToolCalls: vi.fn(),
    isSessionThinking: vi.fn(() => false), setSessionThinking: vi.fn(),
    getSessionExecution: vi.fn(() => undefined), setSessionExecution: vi.fn(), clearSessionExecution: vi.fn(),
    getClientType: vi.fn(() => 'browser'), bindEmbedSession: vi.fn(), unbindEmbedSession: vi.fn(),
    getEmbedSessionsForConnection: vi.fn(() => []), getEmbedSessionConnection: vi.fn(() => null),
    getEmbedSessionBinding: vi.fn(() => null),
  };
  const titleService = { scheduleForFirstUserMessage: vi.fn() };
  const harnessService = {
    prepareMessage: vi.fn(async () => 'event-x'), executeFromEvent: vi.fn(async () => undefined),
    executePrepared: vi.fn(async () => undefined), executeSideFirstMessage: vi.fn(async () => undefined),
    forkParentMessages: vi.fn(async () => undefined), requestCompaction: vi.fn(async () => true),
  };
  const sessionService = {
    getSession: vi.fn(async () => sessionRow),
    saveMessage: vi.fn(async () => ({ id: 900, sessionId, role: 'USER', content: 'content' })),
    updatePhase: vi.fn(), updateField: vi.fn(), updateModelId: vi.fn(), getMessages: vi.fn(),
    editMessageAndTruncate: vi.fn(), save: vi.fn(), findOwnedMessage: vi.fn(async () => null),
    listSubagentSessions: vi.fn(async () => []), cleanupIncompleteTail: vi.fn(async () => 0),
    updateContextTokens: vi.fn(), getLastUserMessage: vi.fn(async () => null),
    deleteMessageById: vi.fn(async () => undefined),
  };
  const taskTerminalService = { finishExecution: vi.fn(async () => undefined) };
  const onScheduledTaskQueueConsumed = vi.fn(async () => undefined);
  const messageQueueService = {
    listPending: vi.fn(async () => []), enqueue: vi.fn(async () => undefined),
    dequeue: vi.fn(async () => null), getById: vi.fn(async () => null),
    delete: vi.fn(async () => undefined), moveToIndex: vi.fn(async () => undefined),
    enqueueHead: vi.fn(async () => undefined),
  };
  const localToolSessionRegistry = {
    setUserForSession: vi.fn(), isConnected: vi.fn(async () => false), failAllForSession: vi.fn(),
    failAllForUser: vi.fn(), completeToolRequest: vi.fn(), completeToolRequestError: vi.fn(),
  };
  const embedPageToolRegistry = {
    request: vi.fn(), complete: vi.fn(() => true), failSession: vi.fn(), isEmbedSession: vi.fn(() => false),
    hasBoundConnection: vi.fn(() => false), pendingCount: vi.fn(() => 0),
  };
  const askUserQuestionsRegistry = {
    failAllForSession: vi.fn(), getPendingForSession: vi.fn(() => []), complete: vi.fn(),
  };
  const treeSignalPublisher = { publishIfSideTask: vi.fn(), publishForSession: vi.fn() };
  const approvalRegistry = { unregister: vi.fn() };
  const activityService = { record: vi.fn() };
  const activityHeartbeat = { touch: vi.fn(), clear: vi.fn() };
  const sessionTodoMapper = { deleteBySessionId: vi.fn(), selectBySessionId: vi.fn(async () => []) };
  const agentLoop = {
    registerCancelFlag: vi.fn(() => { let v = false; return { get: () => v, set: (n: boolean) => { v = n; } }; }),
    removeCancelFlag: vi.fn(), requestCancel: vi.fn(), getCancelFlag: vi.fn(() => undefined),
  };
  const shellSessionManager = { closeByConversation: vi.fn() };
  const skillSyncService = { syncToSession: vi.fn(async () => undefined), getRemovedSkillNames: vi.fn(() => []) };
  const localSkillRegistry = { report: vi.fn(), clear: vi.fn() };
  const localAgentsMdRegistry = { report: vi.fn(), clear: vi.fn() };
  const mcpSyncService = {
    loadAgentServers: vi.fn(async () => []), buildSyncPayload: vi.fn(() => ({})),
    clearSession: vi.fn(), resolveServerIdByName: vi.fn(), recordReport: vi.fn(),
  };
  const mcpClientManager = { closeSession: vi.fn() };
  const compactionSignalBus = new CompactionSignalBus();
  const agentMapper = { selectById: vi.fn(async () => ({ id: 5, name: 'Coder' })) };
  const llmModelMapper = { selectById: vi.fn(async () => ({ supportsVision: 0 })), selectDefault: vi.fn(async () => ({ supportsVision: 0 })) };
  const jwtService = { getAccessTokenMetadata: vi.fn() };

  const handler = new StreamingWsHandler({
    registry, titleService, harnessService, sessionService, taskTerminalService, messageQueueService,
    onScheduledTaskQueueConsumed,
    localToolSessionRegistry, askUserQuestionsRegistry, embedPageToolRegistry, treeSignalPublisher, approvalRegistry, activityService,
    activityHeartbeat, sessionTodoMapper, agentLoop, shellSessionManager, skillSyncService,
    localSkillRegistry, localAgentsMdRegistry, mcpSyncService, mcpClientManager, agentMapper,
    llmModelMapper, jwtService, agentExecutor: (fn) => executor.submit(fn), mcpSyncTimeoutSeconds: 60,
    compactionSignalBus,
  } as unknown as WsHandlerDeps);
  return { handler, executor, registry, sessionService, harnessService, messageQueueService, taskTerminalService, sessionRow };
}

describe('验证探针1：handleInsertMessage 早退分支泄漏 suppressAutoConsumeSend', () => {
  it('队列项已被消费(DELETED)时 insert 早退，抑制标记必须被回收', async () => {
    const userId = 7;
    const h = makeHarness(41, userId);
    h.messageQueueService.getById.mockResolvedValue({
      id: 4, sessionId: 41, userId, content: 'stale', images: null, status: 'DELETED',
    });
    const ws: WsSocket = { id: 'ws-1', readyState: WS_OPEN, send: vi.fn(), close: vi.fn() };
    await h.handler.handleTextMessage(ws, JSON.stringify({
      type: 'insert_message', sessionId: 41, data: { queueId: 4 },
    }));
    await h.executor.runAll();
    const suppress = (h.handler as unknown as { suppressAutoConsumeSend: Set<number> }).suppressAutoConsumeSend;
    expect(suppress.has(41)).toBe(false);
  });

  it('泄漏发生后该会话队列不再自动消费（队列里 PENDING 消息永不执行）', async () => {
    const userId = 7;
    const h = makeHarness(42, userId);
    h.messageQueueService.getById.mockResolvedValue({
      id: 5, sessionId: 42, userId, content: 'stale', images: null, status: 'DELETED',
    });
    const ws: WsSocket = { id: 'ws-1', readyState: WS_OPEN, send: vi.fn(), close: vi.fn() };
    await h.handler.handleTextMessage(ws, JSON.stringify({
      type: 'insert_message', sessionId: 42, data: { queueId: 5 },
    }));
    await h.executor.runAll();

    h.messageQueueService.listPending.mockResolvedValue([
      { id: 6, sessionId: 42, userId, content: 'next', sortOrder: 1, images: null },
    ]);
    h.messageQueueService.dequeue.mockResolvedValue(
      { id: 6, sessionId: 42, userId, content: 'next', sortOrder: 1, images: null },
    );
    await h.handler.autoConsumeQueue(42, userId);
    expect(h.messageQueueService.dequeue).toHaveBeenCalledWith(42);
  });
});
```

### 运行输出

```
 × 验证探针1 > 队列项已被消费(DELETED)时 insert 早退，抑制标记必须被回收
   → expected true to be false // Object.is equality        （suppress.has(41) 残留为 true）
 × 验证探针1 > 泄漏发生后该会话队列不再自动消费
   → expected "spy" to be called with arguments: [ 42 ]     （autoConsumeQueue 未 dequeue，队列停摆）
 Test Files  1 failed (1)
      Tests  2 failed (2)
```

---

## BUG-2【高】压缩触发阈值改用「压缩模型」的上下文窗口，会话模型窗口被无视

### 位置

- `backend-ts/src/harness/core/compaction-service.ts:109`（`resolveEffectiveContextWindow(modelConfig, config)`，此处 `modelConfig` 是**压缩模型**）
- `backend-ts/src/harness/core/compaction-service.ts:113`（`triggerThreshold`）、`:124`（溢出保护）
- `backend-ts/src/harness/core/session-compaction-orchestrator.ts:61-72`（P3 把 `context.modelConfig` 换成 resolver 结果后传入）
- 对照：`backend-ts/src/harness/core/agent-loop.ts:491`（mid-loop 门用 `context.modelConfig`，即**会话模型**）

### 代码事实

```ts
// session-compaction-orchestrator.ts（P3，commit 28ceb7a6）
const compactionModelConfig = this.compactionModelResolver != null
  ? await this.compactionModelResolver.resolve(context.modelConfig)   // admin 设置 compaction.modelId
  : context.modelConfig;
... this.contextManager.compactSession(..., compactionModelConfig!, config, ...);
```

```ts
// compaction-service.ts compactSession：同一个 effectiveWindow 同时驱动「触发阈值」与「压缩请求溢出保护」
const effectiveWindow = CompactionConfig.resolveEffectiveContextWindow(modelConfig, config);  // ← :109 压缩模型的窗口
const triggerThreshold = Math.floor(effectiveWindow * config.triggerRatio);                   // ← :113 阈值随压缩模型漂移
if (!force && measuredTokens < triggerThreshold) { ...; return null; }
...
if (compactionRequestTokens >= effectiveWindow) throw new CompactionContextOverflowException(...);  // ← :124 这里本该用压缩模型窗口
```

同一流程内两处阈值互相矛盾：`agent-loop.ts:491` 的 mid-loop 门用**会话模型**窗口判定"该压缩了"，`compactSession` 却用**压缩模型**判定"没到阈值，跳过"。`activeTokensHint` 采信的是会话请求的真实 prompt usage，与压缩模型窗口不可比。

### 触发链

admin 在系统设置里配了 `compaction.modelId`（`CompactionModelResolver` 校验存在/启用/文本型即采用）→ 该模型 `contextWindowTokens` 与会话模型不同（模型表按模型各自配置）→ 下一次压缩触发判定用错窗口。

### 预期 vs 实际

- 预期：触发阈值 = 会话模型有效窗口 × triggerRatio（防会话请求撑爆会话模型）；溢出保护 = 压缩模型窗口（防压缩请求撑爆压缩模型）。
- 实际：两者都用压缩模型窗口。

### 影响

- 压缩模型窗口**更大**：阈值被抬高到会话模型永远达不到的位置 → 自动压缩永不触发 → 会话请求持续增长直到超过会话模型真实窗口 → 下一轮 LLM 调用被供应商以 context-length 拒绝。安全机制整体失效。
- 压缩模型窗口**更小**：阈值被压低 → 会话才用 20% 就触发压缩，且压缩请求（≈会话规模）必然超过小窗口 → 抛 `CompactionContextOverflowException`，mid-loop 路径原样 rethrow（`agent-loop.ts:498`）直接终止本次执行，报错文案还写着压缩模型的窗口数字，与用户所用模型完全对不上。

### 验证测试（探针，跑完即删）

`backend-ts/src/zz-verify-2-compaction-window.spec.ts`（直接驱动真实 `CompactionService.compactSession`，两个方向各一例）：

```ts
import { describe, expect, it, vi } from 'vitest';
import { CompactionService } from './harness/core/compaction-service.js';
import { TokenEstimator } from './harness/core/token-estimator.js';
import { CompactionConfig } from './harness/core/compaction-config.js';
import type { LlmAdapter, StreamCallback, StreamChunk } from './harness/llm/chat-request.js';
import type { LlmModelConfig } from './model/types.js';
import type { PersistedChatMessage } from './harness/core/compaction-service.js';

function makeConfig(windowTokens: number): CompactionConfig {
  const cfg = new CompactionConfig();
  cfg.enabled = true;
  cfg.triggerRatio = 0.8;
  cfg.contextWindowTokens = windowTokens;
  return cfg;
}

function persisted(): PersistedChatMessage[] {
  return [{ messageId: 5, persistedContentSnapshot: 'x', chatMessage: { role: 'user', content: 'x' } } as never];
}

function bigRequest(): { messages: Array<{ role: 'user'; content: string }>; stream: boolean } {
  return { messages: [{ role: 'user' as const, content: 'x'.repeat(120000) }], stream: true };
}

describe('验证探针2：压缩阈值跟随压缩模型窗口而非会话模型窗口', () => {
  it('压缩模型窗口更大时：阈值被抬高，会话已超自身窗口仍不压缩', async () => {
    let streamed = 0;
    const llmAdapter: LlmAdapter = {
      stream: vi.fn(async (_r: unknown, _c: unknown, cb: StreamCallback) => {
        streamed++;
        cb.onChunk({ choices: [{ index: 0, delta: { content: '<handoff>ok</handoff>' } }] } as StreamChunk);
        cb.onComplete({ promptTokens: 1, completionTokens: 1, totalTokens: 2 });
      }),
      chat: vi.fn(),
    } as unknown as LlmAdapter;
    const svc = new CompactionService(llmAdapter, new TokenEstimator());
    // 会话模型窗口 32000（config 兜底值），压缩模型窗口 1000000
    const compactionModel = { id: 2, modelId: 'huge', contextWindowTokens: 1000000 } as LlmModelConfig;
    const result = await svc.compactSession(
      42, 0, persisted(), [5], bigRequest() as never, compactionModel,
      makeConfig(32000), null, null, 30000, false,
    );
    // 会话真实用量 30000 已超会话窗口阈值 25600，必须触发压缩
    expect(streamed).toBe(1);
    expect(result).not.toBeNull();
  });

  it('压缩模型窗口更小时：阈值被压低，过早触发并抛溢出异常中断执行', async () => {
    const llmAdapter: LlmAdapter = {
      stream: vi.fn(async () => { throw new Error('should not reach LLM'); }),
      chat: vi.fn(),
    } as unknown as LlmAdapter;
    const svc = new CompactionService(llmAdapter, new TokenEstimator());
    // 会话模型窗口 200000，压缩模型窗口 8000
    const compactionModel = { id: 2, modelId: 'small', contextWindowTokens: 8000 } as LlmModelConfig;
    // 真实用量 40000：会话口径阈值 160000，远未达到，不该压缩
    const result = await svc.compactSession(
      42, 0, persisted(), [5], bigRequest() as never, compactionModel,
      makeConfig(200000), null, null, 40000, false,
    );
    expect(result).toBeNull();
  });
});
```

### 运行输出

```
{"level":"INFO","message":"Session handoff compaction skipped below threshold: sessionId=42, measuredTokens=30005, estimatorTokens=30005, threshold=800000"}
 × 压缩模型窗口更大时：阈值被抬高，会话已超自身窗口仍不压缩
   → expected +0 to be 1     （压缩未触发：阈值 800000 = 1000000×0.8，会话口径应为 25600）
 × 压缩模型窗口更小时：阈值被压低，过早触发并抛溢出异常中断执行
   → CompactionContextOverflowException: 会话全量交接压缩请求估算为 30361 tokens，已达到或超过有效上下文窗口 8000 tokens；请改用更大窗口模型或新建会话。
 Test Files  1 failed (1)
      Tests  2 failed (2)
```

---

## BUG-3【高】流式工具调用迟到真实 id：`onToolCallStart` 发两次，注册表留下永久孤儿调用

### 位置

- `backend-ts/src/harness/core/agent-loop.ts:718-719`（`mergeToolCall` 内 id 写回）
- `backend-ts/src/harness/core/agent-loop.ts:312`（`onComplete` 对每个 tool call 再下发一次 start）

### 代码事实

```ts
// agent-loop.ts mergeToolCall：首片无 id 时合成 call-<uuid> 并立即下发 start；
// 后续分片带回真实 id 时把 merged.id 改写为真实 id（2026-10-08 BUG-7 的修复）
if (delta.id && merged.id !== delta.id) {
  const previousId = merged.id;
  merged.id = delta.id;
  if (previousId && emittedEarlyStarts.has(previousId)) emittedEarlyStarts.add(delta.id);  // ← 只新增键，旧键残留
}
...
if (merged?.id && merged.function?.name && !emittedEarlyStarts.has(merged.id)) {
  emittedEarlyStarts.add(merged.id);
  listener.onToolCallStart(merged);          // ← 第一次：合成 id 已发出
}
```

```ts
// agent-loop.ts onComplete：流结束时对每个 tool call 再下发一次 start
if (toolCalls.length > 0) {
  for (const tc of toolCalls) {
    listener.onToolCallStart(tc);            // ← 第二次：真实 id（:312）
  }
  ...
}
```

`emittedEarlyStarts` 只挡住「同一 id 的第二次早发」，挡不住 onComplete 的整表重发；而真实 id 与合成 id 不同键，`WsStreamingEventListener.onToolCallStart`（`ws-streaming-event-listener.ts:96`）的 `alreadySent = toolCallInfo.has(toolCallId)` 去重也失效——两次都是新键。

### 触发链

网关首片只带 `index`+`name`、后续分片才带 `id`（本仓库既有用例 `merges a late id-bearing delta into an id-less first chunk without duplicating dispatch` 明确记录该网关形状存在）→ AgentLoop 合成 `call-<uuid>` 并下发 start → 真实 id 到达改写 `merged.id` → onComplete 再下发一次 start。

### 预期 vs 实际

- 预期：一次逻辑调用只产生一个 `tool_call_start`（真实 id），工具结束后无残留。
- 实际：两个 start（合成 id + 真实 id）、一个 result（真实 id），合成 id 的条目永不完成。

### 影响

1. 桌面端 `useStreamWS.ts` `tool_call_start → appendToolCallStart` 按 `tool_call_id` 建卡 → 同一调用出现两张卡，合成 id 那张永远收不到 `tool_call_result`，永久转圈；
2. `StreamingWsRegistry.trackActiveToolCall` 残留孤儿条目；`streaming-ws-handler.ts:430` 在会话 active 时把 `getActiveToolCalls()` 随 `session_snapshot` 重发 → 刷新/重连后假卡被"恢复"，不是瞬时现象；
3. `onToolCallArgsDelta` 前半段参数挂在合成 id 上、后半段挂在真实 id 上，args 快照被劈成两半。

### 验证测试（探针，跑完即删）

`backend-ts/src/zz-verify-3-duplicate-start.spec.ts`（驱动真实 `AgentLoop`，mock listener + 注册表视角两例）：

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentLoop } from './harness/core/agent-loop.js';
import { AgentExecutionContext } from './harness/core/agent-execution-context.js';
import type { AgentEventListener } from './harness/core/agent-event-listener.js';
import type { PromptEngine } from './harness/core/prompt-engine.js';
import type { ContextManager } from './harness/core/context-manager.js';
import type { BackgroundTaskManager } from './harness/core/background-task-manager.js';
import type { SessionCompactionOrchestrator } from './harness/core/session-compaction-orchestrator.js';
import type { ActiveContextCalculator } from './harness/core/active-context-calculator.js';
import type { ToolDispatcher } from './harness/tool/tool-dispatcher.js';
import type { LlmAdapter, StreamCallback, StreamChunk, ToolCall } from './harness/llm/chat-request.js';
import type { ShellSessionManager } from './harness/shell/shell-session-manager.js';
import type { SessionService } from './harness/deps.js';
import type { McpClientManager } from './harness/mcp/mcp-client-manager.js';
import type { Tool } from './harness/tool/tool.js';

const llmAdapter = { stream: vi.fn(), chat: vi.fn() } as unknown as LlmAdapter & { stream: ReturnType<typeof vi.fn> };
const promptEngine = { buildRequest: vi.fn() } as unknown as PromptEngine & { buildRequest: ReturnType<typeof vi.fn> };
const contextManager = {} as ContextManager;
const toolDispatcher = { dispatchInvocation: vi.fn() } as unknown as ToolDispatcher & { dispatchInvocation: ReturnType<typeof vi.fn> };
const backgroundTaskManager = { consumeCompletedResults: vi.fn() } as unknown as BackgroundTaskManager & { consumeCompletedResults: ReturnType<typeof vi.fn> };
const shellSessionManager = { closeByConversation: vi.fn() } as unknown as ShellSessionManager;
const activityHeartbeat = { touch: vi.fn(), start: vi.fn(), stop: vi.fn(), clear: vi.fn() };
const sessionCompactionOrchestrator = { compact: vi.fn() } as unknown as SessionCompactionOrchestrator & { compact: ReturnType<typeof vi.fn> };
const activeContextCalculator = { activeFromMessageSuffix: vi.fn() } as unknown as ActiveContextCalculator & { activeFromMessageSuffix: ReturnType<typeof vi.fn> };
const mcpClientManager = { closeSession: vi.fn() } as unknown as McpClientManager;
const sessionService = {
  loadContextAnchor: vi.fn(), getMaxMessageId: vi.fn(), getSession: vi.fn(),
  updateContextAnchor: vi.fn(), updateContextTokens: vi.fn(async () => undefined),
} as unknown as SessionService;

const agentLoop = new AgentLoop(
  llmAdapter, promptEngine, contextManager, toolDispatcher, backgroundTaskManager,
  shellSessionManager, activityHeartbeat, sessionService, sessionCompactionOrchestrator,
  activeContextCalculator, mcpClientManager,
);

beforeEach(() => { vi.clearAllMocks(); });

function listener(): AgentEventListener & Record<string, ReturnType<typeof vi.fn>> {
  return {
    onContentDelta: vi.fn(), onToolCallStart: vi.fn(), onToolCallResult: vi.fn(),
    onToolCallArgsDelta: vi.fn(), onMessageEnd: vi.fn(), onError: vi.fn(),
    onThinkingDelta: vi.fn(), onLlmStreamReset: vi.fn(), onContextWindow: vi.fn(),
    onThinkingStart: vi.fn(), onThinkingEnd: vi.fn(), onRoundStart: vi.fn(), onRoundEnd: vi.fn(),
  };
}

function context(): AgentExecutionContext {
  const ctx = new AgentExecutionContext();
  ctx.sessionId = 11; ctx.userId = 7; ctx.executionMode = 'CLOUD';
  ctx.workspace = '/repo'; ctx.permissionLevel = 'READ_ONLY';
  ctx.addUserMessage('hi');
  ctx.tools = [{
    getName: () => 'shell', getDescription: () => '', getInputSchema: () => ({}),
    getOutputSchema: () => ({}), execute: () => '',
  } as Tool];
  return ctx;
}

function toolChunk(tc: Partial<ToolCall>): StreamChunk {
  return { choices: [{ index: 0, delta: { toolCalls: [tc as ToolCall] } }] };
}

/** 网关形状：首片 index+name 无 id；第二片才带真实 id */
function stubLateIdStream(): void {
  let call = 0;
  llmAdapter.stream.mockImplementation(async (_r: unknown, _c: unknown, cb: StreamCallback) => {
    if (call++ === 0) {
      cb.onChunk(toolChunk({ index: 0, function: { name: 'shell', arguments: '{"command":' } }));
      cb.onChunk(toolChunk({ index: 0, id: 'call-real', function: { arguments: '"pwd"}' } }));
      cb.onComplete({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
    } else {
      cb.onChunk({ choices: [{ index: 0, delta: { content: 'done' } }] });
      cb.onComplete({ promptTokens: 4, completionTokens: 1, totalTokens: 5 });
    }
  });
}

describe('验证探针3：迟到真实 id 导致 onToolCallStart 重复下发', () => {
  it('一次逻辑调用只应产生一个 tool_call_start（真实 id）', async () => {
    const ctx = context();
    const l = listener();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    activeContextCalculator.activeFromMessageSuffix.mockReturnValue(5);
    sessionService.loadContextAnchor.mockResolvedValue({ lastPromptTokens: 0, contextAnchorMsgId: 0 } as never);
    sessionService.getMaxMessageId.mockResolvedValue(1 as never);
    sessionService.getSession.mockResolvedValue({ phase: 'RUNNING' } as never);
    toolDispatcher.dispatchInvocation.mockResolvedValue({ callId: 'call-real', status: 'success', content: '{"ok":true}' });
    stubLateIdStream();

    await agentLoop.execute(ctx, l, { onSaveAssistantMessage: vi.fn(), onSaveToolMessage: vi.fn() });

    const startIds = l.onToolCallStart.mock.calls.map(([tc]: [ToolCall]) => tc.id);
    const resultIds = l.onToolCallResult.mock.calls.map(([id]: [string]) => id);
    expect(startIds).toEqual(['call-real']);
    expect(resultIds).toEqual(['call-real']);
  });

  it('注册表视角：track 与 complete 必须一一对应，不得留下孤儿活跃调用', async () => {
    const tracked: string[] = [];
    const completed: string[] = [];
    const base = listener();
    const wrapped: AgentEventListener = {
      ...base,
      onToolCallStart: (tc: ToolCall) => { tracked.push(tc.id ?? ''); base.onToolCallStart(tc); },
      onToolCallResult: (id: string, result: string) => { completed.push(id); base.onToolCallResult(id, result); },
    };
    const ctx = context();
    promptEngine.buildRequest.mockResolvedValue({ messages: [], stream: true });
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    activeContextCalculator.activeFromMessageSuffix.mockReturnValue(5);
    sessionService.loadContextAnchor.mockResolvedValue({ lastPromptTokens: 0, contextAnchorMsgId: 0 } as never);
    sessionService.getMaxMessageId.mockResolvedValue(1 as never);
    sessionService.getSession.mockResolvedValue({ phase: 'RUNNING' } as never);
    toolDispatcher.dispatchInvocation.mockResolvedValue({ callId: 'call-real', status: 'success', content: '{"ok":true}' });
    stubLateIdStream();

    await agentLoop.execute(ctx, wrapped, { onSaveAssistantMessage: vi.fn(), onSaveToolMessage: vi.fn() });

    expect(tracked).toEqual(completed);
  });
});
```

### 运行输出

```
startIds = ["call-real","call-real"] resultIds = ["call-real"]
tracked = ["call-775c8857-b65f-4b24-a8c1-35a9027d7dcb","call-real"] completed = ["call-real"]
 × 一次逻辑调用只应产生一个 tool_call_start（真实 id）
   → expected [ 'call-real', 'call-real' ] to deeply equal [ 'call-real' ]
 × 注册表视角：track 与 complete 必须一一对应，不得留下孤儿活跃调用
   → expected [ …(2) ] to deeply equal [ 'call-real' ]   （tracked 2 项 vs completed 1 项）
 Test Files  1 failed (1)
      Tests  2 failed (2)
```

---

## BUG-4【中】飞书群聊溢出摘要的 llm_call 行 `model_id`/`cost_micros`/`total_tokens` 全丢，成本永久无法归属

### 位置

- `backend-ts/src/create-app.ts:1414-1427`（`GroupContextSummarizer` 的 `resolveModelConfig`，缺 `id` 的那一行是 `:1421-1427`）
- 放大器：`backend-ts/src/usage/llm-call.service.ts:125`（`lookupPrice` 因 `id == null` 直接返回）、`:79`（`modelId: input.modelConfig.id ?? null`）

### 代码事实

```ts
// create-app.ts:1421-1427 —— 返回的 LlmModelConfig 没有 id，也没有四项价格字段
return {
  baseUrl: model.baseUrl, apiKey: model.apiKey, modelId: model.modelId,
  provider: model.provider ?? undefined,
  apiProtocol: model.apiProtocol ?? undefined,
  clientImpersonation: (model.clientImpersonation ?? 'none') as ClientImpersonation,
};
```

`routeChatClient`（`create-app.ts:619-623`）返回的是包了 `llmCallService` 的 `RecordingLlmChatClient`，其 `chat()` 以 `usage: null, costMicros: snapshotCostMicros(config, null)` 落账；`snapshotCostMicros` 仅在四个价格字段全部为 `undefined` 时返回 `undefined`——此处正是如此（价格未随 config 下发）。`LlmCallService.record()` 因此走兜底分支 `resolveCostMicros` → `lookupPrice(input.modelConfig.id)`，而 `id` 为 `undefined`，兜底价格查询根本没被调用。落库 `modelId: null`、`costMicros: null`、`totalTokens: 0`。

### 触发链

飞书群聊上下文溢出 → `GroupContextSummarizer.summarize()`（`scene=feishu_summarize`）→ `resolveLlmClient(config).chat(...)` → `RecordingLlmChatClient` 记账 → 上述丢失。

### 预期 vs 实际

- 期望：与走同一条 `LlmChatClient` 链路的 `ModelService.testConnectivity`（`model.service.ts:284-293`，明确带 `id: model.id`）一致——带上 `id`，成本经兜底查询解析并归属到该模型。
- 实际：`modelId=null`、`costMicros=null`、`totalTokens=0`，`priceLookup` 一次都没被调用。

### 影响

- admin「模型成本」页 `selectLlmCallStatsByModel` 用 `GROUP BY COALESCE(model_id, 0)`，这些行全部落进 id=0 的「未关联模型」桶，飞书群摘要的用量与成本永远无法归属到真实模型；
- 这些行被计入总成本（`llmCallWhere` 默认只排除 `connectivity_test`）但贡献 `NULL`（被 `SUM` 忽略）→ 总成本静默少计；`total_tokens=0` 使 TOKENS 口径的 GLOBAL 预算同样少计，超限判定偏松。

同源佐证：全仓共 6 处构造 `LlmModelConfig`，`llmModelToConfig`（`harness/deps.ts`）、`git-commit-message.service.ts`、`voice-synthesis.service.ts`、`model.service.ts` 全部带 `id`，`create-app.ts:1421` 是唯一漏带的一处。

### 验证测试（探针，跑完即删）

`backend-ts/src/zz-verify-4-feishu-cost.spec.ts`（真实 `GroupContextSummarizer` + 真实 `RecordingLlmChatClient` + 真实 `LlmCallService`）：

```ts
import { describe, expect, it, vi } from 'vitest';
import { GroupContextSummarizer } from './feishu/group-context-summarizer.js';
import { LlmCallContext, LLM_CALL_SCENES } from './usage/llm-call-context.js';
import { LlmCallService } from './usage/llm-call.service.js';
import { RecordingLlmChatClient } from './usage/recording-llm-chat-client.js';
import type { LlmChatClient, LlmChatRequest, LlmChatResponse, LlmModelConfig } from './model/types.js';

const PRICED_MODEL = {
  id: 3, name: 'gpt', provider: 'openai', modelId: 'gpt-4o',
  baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-x', apiProtocol: '',
  clientImpersonation: 'none', modelType: 'text',
  priceInput: '2.000000', priceCacheRead: '1.000000',
  priceCacheWrite: '2.000000', priceOutput: '8.000000',
} as never;

/** create-app.ts 里 GroupContextSummarizer 实际拿到的 config 形状（无 id、无价格）。 */
function summarizerConfig(): LlmModelConfig {
  return {
    baseUrl: PRICED_MODEL.baseUrl, apiKey: PRICED_MODEL.apiKey, modelId: PRICED_MODEL.modelId,
    provider: PRICED_MODEL.provider ?? undefined, apiProtocol: PRICED_MODEL.apiProtocol ?? undefined,
    clientImpersonation: 'none',
  } as LlmModelConfig;
}

function buildCallService() {
  const inserted: Array<Record<string, unknown>> = [];
  const repo = {
    insert: vi.fn(async (row: Record<string, unknown>) => { inserted.push(row); return 1; }),
    list: vi.fn(async () => ({ records: [], total: 0 })),
  };
  const priceLookup = vi.fn(async (id: number) => (id === PRICED_MODEL.id ? PRICED_MODEL : null));
  const service = new LlmCallService(repo as never, undefined, undefined, priceLookup);
  return { service, inserted, priceLookup };
}

function fakeChatClient(): LlmChatClient {
  return {
    async chat(_request: LlmChatRequest, _config: LlmModelConfig): Promise<LlmChatResponse> {
      return { choices: [{ index: 0, message: { role: 'assistant', content: '摘要' }, finish_reason: 'stop' }] } as LlmChatResponse;
    },
  };
}

describe('验证探针4：feishu_summarize 记账丢失 model_id/成本/token', () => {
  it('摘要调用落库 modelId=null 且兜底价格查询从未被调用', async () => {
    const { service, inserted, priceLookup } = buildCallService();
    const summarizer = new GroupContextSummarizer(
      () => new RecordingLlmChatClient(fakeChatClient(), service),
      async () => summarizerConfig(),
      50,
    );

    const text = await LlmCallContext.runAsync(
      { scene: LLM_CALL_SCENES.FEISHU_SUMMARIZE, userId: null, sessionId: 88, agentId: null },
      async () => summarizer.summarize('overflow record', 88),
    );
    expect(text).toBe('摘要');

    expect(inserted).toHaveLength(1);
    const row = inserted[0];
    // 期望：与 testConnectivity 同链路一致带上 id，兜底查询应被调用
    expect(row.modelId).toBe(PRICED_MODEL.id);
    expect(priceLookup).toHaveBeenCalledWith(PRICED_MODEL.id);
  });
});
```

### 运行输出

```
row = {"userId":null,"sessionId":88,"agentId":null,"modelId":null,"modelName":null,"provider":"openai","providerModelId":"gpt-4o","scene":"feishu_summarize","stream":0,"promptTokens":0,"completionTokens":0,"cachedTokens":0,"cacheCreationTokens":0,"totalTokens":0,"costMicros":null,"success":1,...}
 × 摘要调用落库 modelId=null 且兜底价格查询从未被调用
   → expected null to be 3
 Test Files  1 failed (1)
      Tests  1 failed (1)
```

---

## BUG-5【中】manifest 快照落库无顺序保证：刷新后回放到旧快照（含旧 token 数）

### 位置

- `backend-ts/src/harness/core/agent-loop.ts:520-528`（`persistContextSnapshot`，每次 `onContextWindow` 前再写一次，fire-and-forget）
- `backend-ts/src/session/ws/ws-streaming-event-listener.ts:164-171`（listener 侧同一份值再写一次，同样 `void`）

### 代码事实

```ts
// agent-loop.ts:520-528 —— 无排队无 await
private persistContextSnapshot(context: AgentExecutionContext, tokens: number): void {
  if (context.sessionId == null) return;
  void this.sessionService.updateContextTokens(
    context.sessionId, tokens, contextManifestJson(context.contextManifest),
  ).catch(() => {});
}
```

```ts
// ws-streaming-event-listener.ts:170 —— listener 侧同一份值再写一次
void this.deps.sessionService.updateContextTokens(this.sessionId, estimatedTokens, manifestJson).catch(() => {});
```

代码注释自称"listener 再写一次是同一份 JSON"——但只保证了同一事件的两次写相同，没有保证**跨事件**（轮首估算 `estimatedTokens` vs `onComplete` 真实 `promptTokens`，以及上一轮 vs 下一轮的 manifest）的落库顺序。两个写方都是 `void`，经 mysql2 连接池并发下发时 UPDATE 的落库顺序不保证与发出顺序一致，旧快照可以覆盖新快照。

### 触发链

任一轮次 → `persistContextSnapshot` 与 `listener.onContextWindow` 各发一次 `UPDATE session SET context_tokens=?, context_manifest_json=?`（同一行、值随时间变化）→ 连接池并发执行、乱序落库 → 行收敛到较早的写。

### 预期 vs 实际

- 期望：DB 快照收敛到最后一次 `context_window` 推送（该功能的设计目的"刷新后回放与推送一致"）。
- 实际：DB 行停留在更早的轮次/估算值——刷新后上下文抽屉显示旧构成与旧 token 数，直到下一次请求才自愈。

### 影响

刷新页面（或切换会话后返回）时，上下文抽屉显示落后一轮的构成清单与 token 水位。触发条件是 DB 写延迟/连接池竞争导致并发 UPDATE 乱序（生产 mysql2 池下两个连接并发提交顺序不保证）。

### 验证测试（探针，跑完即删）

`backend-ts/src/zz-verify-5-manifest-race.spec.ts`（真实 `AgentLoop` + 真实 `WsStreamingEventListener`，fake `sessionService.updateContextTokens` 按"先发出的写落库慢"模拟连接池乱序）：

```ts
import { describe, expect, it, vi } from 'vitest';
import { AgentLoop } from './harness/core/agent-loop.js';
import { AgentExecutionContext } from './harness/core/agent-execution-context.js';
import { WsStreamingEventListener } from './session/ws/ws-streaming-event-listener.js';
import { StreamingWsRegistry } from './session/ws/streaming-ws-registry.js';
import type { AgentEventListener } from './harness/core/agent-event-listener.js';
import type { PromptEngine } from './harness/core/prompt-engine.js';
import type { ContextManager } from './harness/core/context-manager.js';
import type { BackgroundTaskManager } from './harness/core/background-task-manager.js';
import type { SessionCompactionOrchestrator } from './harness/core/session-compaction-orchestrator.js';
import type { ActiveContextCalculator } from './harness/core/active-context-calculator.js';
import type { ToolDispatcher } from './harness/tool/tool-dispatcher.js';
import type { LlmAdapter, StreamCallback, StreamChunk, ToolCall } from './harness/llm/chat-request.js';
import type { ShellSessionManager } from './harness/shell/shell-session-manager.js';
import type { SessionService } from './harness/deps.js';
import type { McpClientManager } from './harness/mcp/mcp-client-manager.js';
import type { Tool } from './harness/tool/tool.js';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('验证探针5：manifest 快照乱序落库回退到旧值', () => {
  it('真实 AgentLoop + 真实 WsStreamingEventListener：DB 行必须收敛到最后一次推送', async () => {
    const llmAdapter = { stream: vi.fn(), chat: vi.fn() } as unknown as LlmAdapter & { stream: ReturnType<typeof vi.fn> };
    const promptEngine = { buildRequest: vi.fn() } as unknown as PromptEngine & { buildRequest: ReturnType<typeof vi.fn> };
    const toolDispatcher = { dispatchInvocation: vi.fn() } as unknown as ToolDispatcher & { dispatchInvocation: ReturnType<typeof vi.fn> };
    const backgroundTaskManager = { consumeCompletedResults: vi.fn() } as unknown as BackgroundTaskManager & { consumeCompletedResults: ReturnType<typeof vi.fn> };
    const activityHeartbeat = { touch: vi.fn(), start: vi.fn(), stop: vi.fn(), clear: vi.fn() };
    const sessionCompactionOrchestrator = { compact: vi.fn() } as unknown as SessionCompactionOrchestrator & { compact: ReturnType<typeof vi.fn> };
    const activeContextCalculator = { activeFromMessageSuffix: vi.fn() } as unknown as ActiveContextCalculator & { activeFromMessageSuffix: ReturnType<typeof vi.fn> };
    const mcpClientManager = { closeSession: vi.fn() } as unknown as McpClientManager;

    interface Write { seq: number; tokens: number; manifestJson: string | null }
    const issued: Write[] = [];
    let dbRow: { contextTokens: number | null; contextManifestJson: string | null } = { contextTokens: null, contextManifestJson: null };
    // 模拟连接池并发：先发出的写落库慢、后发出的写落库快（生产 mysql2 池下顺序不保证）
    const sessionService = {
      loadContextAnchor: vi.fn(async () => ({ lastPromptTokens: 0, contextAnchorMsgId: 0 })),
      getMaxMessageId: vi.fn(async () => 1),
      getSession: vi.fn(async () => ({ phase: 'RUNNING' })),
      updateContextAnchor: vi.fn(async () => undefined),
      updateContextTokens: vi.fn(async (_sid: number, tokens: number, manifestJson?: string | null) => {
        const seq = issued.length;
        const w: Write = { seq, tokens, manifestJson: manifestJson ?? null };
        issued.push(w);
        await sleep(120 - seq * 15);
        dbRow = { contextTokens: tokens, contextManifestJson: manifestJson ?? null };
      }),
    } as unknown as SessionService;

    const agentLoop = new AgentLoop(
      llmAdapter, promptEngine, {} as ContextManager, toolDispatcher, backgroundTaskManager,
      { closeByConversation: vi.fn() } as unknown as ShellSessionManager, activityHeartbeat, sessionService,
      sessionCompactionOrchestrator, activeContextCalculator, mcpClientManager,
    );

    const registry = new StreamingWsRegistry();
    const pushed: Array<{ estimated: number; key: string | null }> = [];
    const listener = new WsStreamingEventListener(
      {
        registry,
        activityService: { record: vi.fn(async () => ({ id: 42 })) } as never,
        activityHeartbeat: { touch: vi.fn() },
        sessionTodoMapper: { selectBySessionId: vi.fn(async () => []) },
        sessionService,
      } as never,
      11, 7, 'exec-1', true,
    );
    const originalSend = registry.send.bind(registry);
    vi.spyOn(registry, 'send').mockImplementation(((_userId: number, event: { type: string; data?: Record<string, unknown> }) => {
      if (event.type === 'context_window' && event.data) {
        const d = event.data as { estimated: number; manifest?: { sections?: Array<{ key?: string }> } };
        pushed.push({ estimated: d.estimated, key: d.manifest?.sections?.[0]?.key ?? null });
      }
      return originalSend(_userId, event as never);
    }) as never);

    let round = 0;
    promptEngine.buildRequest.mockImplementation(async (c: AgentExecutionContext) => {
      round += 1;
      c.contextManifest = { sections: [{ key: `round-${round}`, label: `第${round}轮`, tokens: 1000 * round }], memoryIds: [], estimatedWindowTokens: 256000 };
      return { messages: [], stream: true };
    });
    activeContextCalculator.activeFromMessageSuffix.mockReturnValue(42);
    backgroundTaskManager.consumeCompletedResults.mockReturnValue({});
    toolDispatcher.dispatchInvocation.mockResolvedValue({ callId: 'call-1', status: 'success', content: '{"ok":true}' });
    let call = 0;
    llmAdapter.stream.mockImplementation(async (_r: unknown, _c: unknown, cb: StreamCallback) => {
      if (call++ === 0) {
        cb.onChunk({ choices: [{ delta: { toolCalls: [{ id: 'call-1', function: { name: 'read_file', arguments: '{"path":"a"}' } } as ToolCall] } }] } as StreamChunk);
        cb.onComplete({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
      } else {
        cb.onChunk({ choices: [{ index: 0, delta: { content: 'done' } }] } as StreamChunk);
        cb.onComplete({ promptTokens: 4, completionTokens: 1, totalTokens: 5 });
      }
    });

    const ctx = new AgentExecutionContext();
    ctx.sessionId = 11; ctx.userId = 7; ctx.executionMode = 'CLOUD';
    ctx.addUserMessage('hi');
    ctx.tools = [{
      getName: () => 'read_file', getDescription: () => '', getInputSchema: () => ({}),
      getOutputSchema: () => ({}), execute: () => '',
    } as Tool];

    await agentLoop.execute(ctx, listener as unknown as AgentEventListener, { onSaveAssistantMessage: vi.fn(), onSaveToolMessage: vi.fn() });
    await sleep(800);

    const lastPushed = pushed.at(-1)!;
    const dbKey = dbRow.contextManifestJson != null
      ? (JSON.parse(dbRow.contextManifestJson) as { sections?: Array<{ key?: string }> })?.sections?.[0]?.key ?? null
      : null;
    expect(pushed.length).toBeGreaterThan(1);
    expect(issued.length).toBeGreaterThan(1);
    // 期望：DB 收敛到最后一次推送的 token 与构成
    expect(dbRow.contextTokens).toBe(lastPushed.estimated);
    expect(dbKey).toBe(lastPushed.key);
    listener.dispose();
    registry.shutdown();
  });
});
```

### 运行输出

```
issued = 0:42:round-1 | 1:42:round-1 | 2:3:round-1 | 3:3:round-1 | 4:42:round-2 | 5:42:round-2 | 6:4:round-2 | 7:4:round-2
lastPushed = {"estimated":4,"key":"round-2"} dbRow = 42 round-1
 × DB 行必须收敛到最后一次推送
   → expected 42 to be 4        （DB 停在第 1 轮估算值 42/round-1，最后推送是 4/round-2）
 Test Files  1 failed (1)
      Tests  1 failed (1)
```

---

## BUG-6【中】流式调用被上游中断时丢弃已到达的 usage，llm_call 记 0 token / 0 成本

### 位置

- 主因：`backend-ts/src/harness/llm/anthropic-llm-adapter.ts:255-263, 406-410, 415-420`（usage 只在流末一次性汇总，`processStreamBody` 内四个累计局部变量在中断时被整体丢弃）；`openai-llm-adapter.ts:315-321, 362`（usage 对象随分片就地累加，但同样只在 `[DONE]` 后经 `onComplete` 暴露）
- 放大器：`backend-ts/src/usage/recording-llm-adapter.ts:97-100, 118-129`（只认 `onComplete` 这一条取用通道）

### 代码事实

```ts
// anthropic-llm-adapter.ts:406-410 —— 中断路径
if (!done) {
  const eof = Object.assign(new Error('stream ended before message_stop'), { name: 'EOFException' });
  if (emitted) throw new StreamInterruptedAfterOutputException(eof);
  throw eof;
}
// anthropic-llm-adapter.ts:415-420 —— 只有走到这里 usage 才被填充并经 onComplete 暴露
const finalized = finalizeUsage(inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens);
usage.promptTokens = finalized.promptTokens;
...
callback.onComplete(usage);
```

`stream()` 的 catch 走 `callback.onError(...)` 且不 rethrow，于是 `RecordingLlmAdapter` 的包装器 `onComplete` 永不被触发，`usage` 保持 `undefined`：

```ts
// recording-llm-adapter.ts:97-100
onComplete: (u) => {
  usage = u;              // 中断路径下永不到达
  callback.onComplete(u);
},
// recording-llm-adapter.ts:118-129 finally
await this.callService.record({ ..., usage, success, ..., costMicros: snapshotCostMicros(config, usage) });
```

`snapshotCostMicros(config, undefined)` → 四价齐全时算出 **0**（所有 token 类为 0）。

### 触发链

1. 上游在 `message_stop`（Anthropic）/ `[DONE]`（OpenAI）之前断开连接；或用户中途取消本轮流式输出（`Cancelled by user` 同样走 `onError`）；
2. `processStreamBody` 抛 `StreamInterruptedAfterOutputException` → `stream()` catch → `onError`，`onComplete` 不执行；
3. `record()` 落库 `promptTokens=0 / completionTokens=0 / cachedTokens=0 / cacheCreationTokens=0 / totalTokens=0 / costMicros=0 / success=0`；
4. `errorMessage` 是「模型流式响应已中断，自动重试已耗尽」——说明本轮**已经产生了输出**（上游照常计费），却按 0 记账。

### 预期 vs 实际

- 预期（技术方案 §5.2）：「失败调用（success=0）若产生了 token（上游计费）照常计价；totalTokens=0 的失败行成本为 0」——两者是不同情形，本场景属前者。
- 实际：`success=0` 且 `totalTokens=0` 且 `costMicros=0`，上游已上报的 usage 被丢弃。

### 影响

- 被中断/取消的流式轮次在账面上免费。真实场景（用户点停止、网关截断）会持续发生，`SUM(cost_micros)` 系统性偏低；
- 预算域 `checkAdmission` 用 `SUM(cost_micros) >= limitValue` 判 BLOCK，少计会让失控 Agent 突破预算仍不被拦截；
- 用户取消、模型截断等排障场景在「调用流水」页显示 0 token，误导容量/成本分析。

### 验证测试（探针，跑完即删）

`backend-ts/src/zz-verify-6-interrupted-usage.spec.ts`（真实 SSE server + 真实双协议适配器 + 真实 `RecordingLlmAdapter` + 真实 `LlmCallService`）：

```ts
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicLlmAdapter } from './harness/llm/anthropic-llm-adapter.js';
import { OpenAiLlmAdapter } from './harness/llm/openai-llm-adapter.js';
import { DEFAULT_LLM_RETRY } from './harness/llm/chat-request.js';
import type { ChatRequest, LlmModelConfig, LlmRetryConfig, StreamCallback, StreamChunk, ChatUsage } from './harness/llm/chat-request.js';
import { RecordingLlmAdapter } from './usage/recording-llm-adapter.js';
import { LlmCallService } from './usage/llm-call.service.js';
import { LlmCallContext } from './usage/llm-call-context.js';

class SseServer {
  private server!: http.Server;
  constructor(private readonly lines: string[]) {}
  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.flushHeaders();
        for (const line of this.lines) res.write(line);
        res.end(); // 上游中断：不发 message_stop / [DONE]
      });
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  async close(): Promise<void> {
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

class CapturingCallback implements StreamCallback {
  usage?: ChatUsage;
  error?: unknown;
  onChunk(_chunk: StreamChunk): void { /* noop */ }
  onComplete(usage: ChatUsage): void { this.usage = usage; }
  onError(t: unknown): void { this.error = t; }
}

function retryConfig(): LlmRetryConfig {
  return {
    ...DEFAULT_LLM_RETRY,
    rateLimitMaxRetries: 0,
    callTimeoutSeconds: 5,
    streamIdleTimeoutSeconds: 5,
    httpCallTimeoutSeconds: 5,
  };
}

function request(): ChatRequest {
  return { temperature: 0.2, messages: [{ role: 'user', content: 'hi' }] };
}

function configOf(url: string): LlmModelConfig {
  return {
    id: 1, name: 'm', baseUrl: url + '/v1', apiKey: 'k', modelId: 'm',
    priceInput: 2, priceCacheRead: 1, priceCacheWrite: 2, priceOutput: 8,
  } as unknown as LlmModelConfig;
}

function buildRecorder() {
  const inserted: Array<Record<string, unknown>> = [];
  const repo = {
    insert: vi.fn(async (row: Record<string, unknown>) => { inserted.push(row); return 1; }),
    list: vi.fn(async () => ({ records: [], total: 0 })),
  };
  const priceLookup = vi.fn(async () => ({ priceInput: 2, priceCacheRead: 1, priceCacheWrite: 2, priceOutput: 8 }));
  const callService = new LlmCallService(repo as never, undefined, undefined, priceLookup);
  return { callService, inserted };
}

/** Anthropic：message_start + content + message_delta(完整 usage)，随后上游断开 */
const ANTHROPIC_INTERRUPTED = [
  'data: {"type":"message_start","message":{"id":"m","usage":{"input_tokens":600,"cache_creation_input_tokens":200,"cache_read_input_tokens":400,"output_tokens":1}}}\n\n',
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}\n\n',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_token"},"usage":{"input_tokens":600,"cache_creation_input_tokens":200,"cache_read_input_tokens":400,"output_tokens":200}}\n\n',
];

/** OpenAI：usage 在最后一个分片里，随后上游断开（未发 [DONE]） */
const OPENAI_INTERRUPTED = [
  'data: {"id":"c","choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n',
  'data: {"id":"c","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1000,"completion_tokens":200,"total_tokens":1200,"prompt_tokens_details":{"cached_tokens":400}}}\n\n',
];

describe('验证探针6：中断的流式调用丢弃已到达 usage，记 0 token / 0 成本', () => {
  let server: SseServer | undefined;
  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  it('Anthropic：message_delta 已带回 usage，落库行却全是 0', async () => {
    server = new SseServer(ANTHROPIC_INTERRUPTED);
    const url = await server.start();
    const delegate = new AnthropicLlmAdapter(retryConfig());
    const { callService, inserted } = buildRecorder();
    const recording = new RecordingLlmAdapter(delegate, callService);
    const cb = new CapturingCallback();

    await LlmCallContext.runAsync({ scene: 'agent', userId: 1, sessionId: 2, agentId: 3 }, async () => {
      await recording.stream(request(), configOf(url), cb);
    });
    expect(cb.error).toBeDefined();

    expect(inserted).toHaveLength(1);
    const row = inserted[0];
    // 期望：失败调用产生了 token 照常计价（600+200+400 输入 / 200 输出）
    expect(row.promptTokens).toBe(1200);
    expect(row.completionTokens).toBe(200);
    expect(row.cacheCreationTokens).toBe(200);
    expect(row.cachedTokens).toBe(400);
    // 600×2 + 400×1 + 200×2 + 200×8 = 3600
    expect(row.costMicros).toBe(3600);
  });

  it('OpenAI：同样形状下 usage 也已到达，落库行却全是 0', async () => {
    server = new SseServer(OPENAI_INTERRUPTED);
    const url = await server.start();
    const delegate = new OpenAiLlmAdapter(retryConfig());
    const { callService, inserted } = buildRecorder();
    const recording = new RecordingLlmAdapter(delegate, callService);
    const cb = new CapturingCallback();

    await LlmCallContext.runAsync({ scene: 'agent', userId: 1, sessionId: 2, agentId: 3 }, async () => {
      await recording.stream(request(), configOf(url), cb);
    });
    expect(cb.error).toBeDefined();

    expect(inserted).toHaveLength(1);
    const row = inserted[0];
    expect(row.promptTokens).toBe(1000);
    expect(row.completionTokens).toBe(200);
    expect(row.cachedTokens).toBe(400);
    // 600×2 + 400×1 + 200×8 = 3200
    expect(row.costMicros).toBe(3200);
  });
});
```

### 运行输出

```
ANTHROPIC ROW: {...,"stream":1,"promptTokens":0,"completionTokens":0,"cachedTokens":0,"cacheCreationTokens":0,"totalTokens":0,"costMicros":0,"success":0,"errorMessage":"模型流式响应已中断，自动重试已耗尽",...}
OPENAI ROW: {...,"stream":1,"promptTokens":0,"completionTokens":0,"cachedTokens":0,"cacheCreationTokens":0,"totalTokens":0,"costMicros":0,"success":0,"errorMessage":"模型流式响应已中断，自动重试已耗尽",...}
 × Anthropic：message_delta 已带回 usage，落库行却全是 0
   → expected +0 to be 1200
 × OpenAI：同样形状下 usage 也已到达，落库行却全是 0
   → expected +0 to be 1000
 Test Files  1 failed (1)
      Tests  2 failed (2)
```

---

## BUG-7【中】拖拽排序在 REST 初始队列上静默失效：队列消息 id 两条通道类型不一致

### 位置

- 服务端 REST VO：`backend-ts/src/session/session-vo.ts:449-463`（`toQueueMessageVO`，`:458` `id: item.id` 数字）
- 服务端 WS 推送：`backend-ts/src/session/ws/streaming-ws-handler.ts:1724-1738`（`sendQueueUpdated`，`:1729` `id: String(item.id)` 字符串）
- 前端 REST 灌入：`desktop/src/composables/useChat.ts:917-926`（`fetchQueue`）、`desktop/src/composables/useStreamWS.ts:108-115`（`refreshQueue`）——原样写 store，不归一化
- 前端拖拽入口：`desktop/src/components/chat/QueuePanel.vue:216-227`（`:224` 严格相等匹配）

### 代码事实

服务端两条通道对同一行数据给出**不同的 id 类型**：

```ts
// session-vo.ts:457-462 —— REST /v1/sessions/:id/queue
const vo = { id: item.id, sessionId: item.sessionId, ... }   // BIGINT → JS number
```

```ts
// streaming-ws-handler.ts:1728-1731 —— WS queue_updated
const map = { id: String(item.id), sessionId: String(item.sessionId), ... }  // 字符串
```

前端 `QueueMessage` 类型声明为字符串（`desktop/src/types/chat.ts:115-118`），但 REST 灌入不做归一化；而拖拽结束用 `dataset.queueId`（DOM 永远是字符串）与 store 里的 id 做**严格相等**：

```ts
// QueuePanel.vue:216-227
function onDragStart(e: SortableEvent) {
  draggingQueueId.value = e.item?.dataset.queueId ?? null      // 字符串 "4"
}
function onDragEnd(e: SortableEvent) {
  const draggedId = draggingQueueId.value ?? e.item?.dataset.queueId ?? null
  ...
  const toIndex = queueView.value.findIndex(v => v.msg.id === draggedId)   // 4 === "4" → false
  if (toIndex < 0 || e.oldIndex === toIndex) return                        // 命中 toIndex < 0，静默 return
  handleReorder(draggedId, toIndex)
}
```

### 触发链

1. 用户打开有待发送消息的会话（或切换会话、取消后复位）：`useChat.ts:1032` 调 `fetchQueue()` → REST GET `/sessions/:id/queue` → `toQueueMessageVO` 返回**数字** id → store 里 `msg.id === 4`（number）；
2. 服务端 `handleSubscribe`（`streaming-ws-handler.ts:398-439`）**不推送** `queue_updated`，所以此刻没有任何 WS 帧把 id 纠正成字符串；
3. 用户按住拖拽块把消息从第 1 位拖到第 2 位。`vue-draggable-plus` 内部 `onUpdate` 已把 `queueView` 乐观重排为 `[5,4,6]`；
4. `onDragEnd` 执行：`draggedId = "4"`，`queueView.findIndex(v => v.msg.id === "4")` 因 `4 !== "4"` 返回 **-1** → 命中 `if (toIndex < 0 …) return`；
5. **不发 `reorder`**，无任何错误提示。由于 `queueView` 已被本地乐观重排而服务端顺序未变，界面显示的顺序与库内不一致，并一直持续到下一次 `fetchQueue`/`queue_updated`（切会话/取消/下一条队列消息被消费）才被纠正。

只有先执行过一次会产生 `queue_updated` 的动作（如再入队一条消息）后，id 才变回字符串、拖拽才恢复——这解释了为什么该问题在随手测试中不易暴露。

### 预期 vs 实际

- 预期：无论队列最后一次由 REST 还是 WS 灌入，拖拽都应发出 `reorder(queueId, targetIndex)`，服务端 `moveToIndex` 落库并推送 `queue_updated` 对齐。
- 实际：队列由 REST 灌入（即默认初始态）时拖拽**完全静默失效**，不发任何 WS 消息，前端乐观顺序与服务端库内顺序长期分叉，无任何用户可见反馈。影响所有平台（Web / Electron / 安卓 Capacitor 远程加载）。

### 为何既有测试没发现

`4b3aa658` 的 7 个 `moveToIndex*` 用例全部在 `MessageQueueService` 层用内存 fake 驱动，只覆盖 `sort_order` 算术；`streaming-ws-handler.spec.ts` 只断言 `moveToIndex` 被调用；desktop 侧 vitest 是 `environment: 'node'` 且无 jsdom/`@vue/test-utils`，`.vue` SFC 无法挂载，`onDragEnd` 这条路根本没有自动化覆盖。

### 验证测试（探针，跑完即删）

`desktop/src/components/chat/zz-verify-7-queue-drag.test.ts`（读 SFC 源码 + `ts.transpileModule` + `new Function` 注入 free variables，驱动**真实** `onDragStart`/`onDragEnd`/`handleReorder` 源码）：

```ts
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'QueuePanel.vue'), 'utf8')

function extractFn(name: string): string {
  const marker = `function ${name}(`
  const start = sfc.indexOf(marker)
  if (start < 0) throw new Error(`function ${name} not found`)
  let depth = 0
  for (let i = sfc.indexOf('{', start); i < sfc.length; i++) {
    if (sfc[i] === '{') depth++
    else if (sfc[i] === '}') {
      depth--
      if (depth === 0) return sfc.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces for ${name}`)
}

type SortableEventLike = { oldIndex?: number; item?: { dataset?: Record<string, string> } }

function buildHarness() {
  const draggingQueueId: { value: string | null } = { value: null }
  const queueView: { value: Array<{ msg: { id: unknown; content: string } }> } = { value: [] }
  const reorderCalls: Array<{ queueId: unknown; targetIndex: unknown }> = []
  const emit = (_e: string, queueId: unknown, targetIndex: unknown) => { reorderCalls.push({ queueId, targetIndex }) }
  const reordering = { value: false }
  const reorderResetTimer = { value: null as ReturnType<typeof setTimeout> | null }
  const factory = new Function(
    'draggingQueueId', 'queueView', 'emit', 'reordering', 'reorderResetTimer', 'setTimeout', 'clearTimeout',
    ts.transpileModule(
      `${extractFn('onDragStart')}\n${extractFn('onDragEnd')}\n${extractFn('handleReorder')}\nreturn { onDragStart, onDragEnd }`,
      { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } },
    ).outputText,
  )
  const fns = factory(draggingQueueId, queueView, emit, reordering, reorderResetTimer, () => 0 as never, () => undefined) as {
    onDragStart: (e: SortableEventLike) => void
    onDragEnd: (e: SortableEventLike) => void
  }
  return { ...fns, reorderCalls, queueView }
}

/** REST /v1/sessions/:id/queue 的真实形状（toQueueMessageVO：id/sessionId 为数字）。 */
function restQueueShape(ids: number[]) {
  return ids.map((id, i) => ({ id, sessionId: 11, content: `m${id}`, sortOrder: i + 1, createdAt: '2026-10-08 10:00:00' }))
}

/** WS queue_updated 的真实形状（sendQueueUpdated：id/sessionId 为字符串）。 */
function wsQueueShape(ids: number[]) {
  return ids.map((id, i) => ({ id: String(id), sessionId: '11', content: `m${id}`, sortOrder: i + 1, createdAt: '2026-10-08 10:00:00' }))
}

/** DOM dataset 永远是字符串：data-queue-id="4" -> dataset.queueId === "4"。 */
function dragEvent(queueId: string, oldIndex: number): SortableEventLike {
  return { oldIndex, item: { dataset: { queueId } } }
}

describe('验证探针7：REST 数字 id 下拖拽排序静默失效', () => {
  it('REST 形状（数字 id）：拖拽不发 reorder（findIndex 匹配不到）', () => {
    const h = buildHarness()
    h.queueView.value = restQueueShape([4, 5, 6]).map((m) => ({ msg: m }))
    h.onDragStart(dragEvent('4', 0))
    h.onDragEnd(dragEvent('4', 0))
    // 故障复现：reorder 一次都没发
    expect(h.reorderCalls).toEqual([])
  })

  it('WS 形状（字符串 id）：同一份代码拖拽正常发出 reorder', () => {
    const h = buildHarness()
    h.queueView.value = wsQueueShape([4, 5, 6]).map((m) => ({ msg: m }))
    // vue-draggable-plus 内部 onUpdate 已把 queueView 重排为 [5,4,6]
    h.queueView.value = [h.queueView.value[1], h.queueView.value[0], h.queueView.value[2]]
    h.onDragStart(dragEvent('4', 0))
    h.onDragEnd(dragEvent('4', 0))
    expect(h.reorderCalls).toEqual([{ queueId: '4', targetIndex: 1 }])
  })
})
```

### 运行输出

```
 ✓ src/components/chat/zz-verify-7-queue-drag.test.ts (2 tests) 36ms
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

（两条全 pass = 故障复现：第一条断言 REST 形状下 `reorderCalls` 为空，即拖拽确实什么都没发；第二条证明换成字符串 id 后同一份代码立刻正常，把根因锁定在 id 类型不一致。）

---

## BUG-8【中】`SideChatPanel.loadSideSessionMeta` 迟到响应无守卫：把来源会话的 phase 写进当前会话，并覆写 `sending`

### 位置

- `desktop/src/components/chat/SideChatPanel.vue:536-550`（`loadSideSessionMeta`，`:544` await 后重读 `realSessionId.value`）
- 对照：同文件 `fetchSourceSessionMeta`（`:226-241`）有 `fetchedSourceMetaId.value !== sourceId` 守卫，`fetchMessages`/`loadOlderMessages`/`fetchQueue` 都在 await 前把 `sid` 捕获成局部变量——只有这一个函数在 await 之后重读 `realSessionId.value`，属漏加。

### 代码事实

```ts
async function loadSideSessionMeta() {
  if (!hasRealSession.value) return
  try {
    const { data } = await api.get(`/sessions/${realSessionId.value}`)   // ← URL 用调用时的 realSessionId
    if (data?.modelId != null) { sideModelId.value = sideModelId.value ?? data.modelId }
    if (data?.phase) {
      sessionStore.updateSessionPhase(String(realSessionId.value), data.phase)  // ← await 后重读，已是新会话
      sending.value = ACTIVE_PHASES.has(data.phase)                             // ← 用旧会话 phase 覆写忙碌态
    }
  } catch { /* ignore */ }
}
```

watcher（`:504-533`）的 `else if` 分支只改 `realSessionId`、不重拉 meta：

```ts
} else if (newId > 0 && realSessionId.value !== newId) {
  realSessionId.value = newId      // ← :531 同一 Tab 组件实例被指派给另一个边路会话
}
```

### 触发链

占位 Tab 挂载（`sideSessionId=0`）→ `side_session_created` 把 `tab.sideSessionId` 写成 101，watcher 走占位→转正分支，发出 `GET /sessions/101` → 同一个 Tab 组件实例又被指派给边路会话 202（watcher 的 `else if` 分支）→ 101 的响应迟到返回。

### 预期 vs 实际

- 期望：迟到响应被丢弃；202 的 phase 缓存保持未设置，`sending` 不受 101 影响。
- 实际：`phaseOf202 === 'RUNNING'`（101 的 phase 落到了 202 上），面板出现 typing indicator / 停止按钮。

### 影响

边路任务 Tab 显示错误的执行态（加载中/停止按钮/打字点），且 phase 缓存被污染会连带影响 `isSideActive`、`canContinue`、侧栏圆点与 `SideTaskList` 排序。是 `4167c9d9`（最近 7 天）修过的 post-await guard 模式在桌面端的漏网点；该竞态窗口由边路 fork/Fork 预览（`0cfef917`、`0e40eff3`）丰富化的占位 Tab 复用流程触达。

### 验证测试（探针，跑完即删）

`desktop/src/components/chat/zz-verify-8-side-meta-race.test.ts`（抽取真实 `loadSideSessionMeta` 源码执行，可控 deferred 模拟迟到响应）：

```ts
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import ts from 'typescript'

const here = dirname(fileURLToPath(import.meta.url))
const sfc = readFileSync(join(here, 'SideChatPanel.vue'), 'utf8')

function extractFn(name: string): string {
  const marker = `function ${name}(`
  const start = sfc.indexOf(marker)
  if (start < 0) throw new Error(`function ${name} not found`)
  let depth = 0
  for (let i = sfc.indexOf('{', start); i < sfc.length; i++) {
    if (sfc[i] === '{') depth++
    else if (sfc[i] === '}') {
      depth--
      if (depth === 0) return sfc.slice(start, i + 1)
    }
  }
  throw new Error(`unbalanced braces for ${name}`)
}

interface Deferred { promise: Promise<unknown>; resolve: (v: unknown) => void }
function deferred(): Deferred {
  let resolve!: (v: unknown) => void
  const promise = new Promise((res) => { resolve = res })
  return { promise, resolve }
}

describe('验证探针8：loadSideSessionMeta 迟到响应污染当前会话 phase 与 sending', () => {
  it('会话 101 的在途响应迟到返回时，不得把 101 的 phase 写到会话 202', async () => {
    const realSessionId = { value: 0 }
    const sideModelId = { value: undefined as number | undefined }
    const sending = { value: false }
    const hasRealSession = { value: false }
    const phaseWrites: Array<{ sid: string; phase: string }> = []
    const sessionStore = {
      updateSessionPhase: vi.fn((sid: string, phase: string) => { phaseWrites.push({ sid, phase }) }),
    }
    const gets = new Map<string, Deferred>()
    const api = {
      get: vi.fn((url: string) => {
        const d = deferred()
        gets.set(url, d)
        return d.promise as never
      }),
    }

    const factory = new Function(
      'api', 'sessionStore', 'realSessionId', 'sideModelId', 'sending', 'hasRealSession',
      ts.transpileModule(
        `const ACTIVE_PHASES = new Set(['RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING'])\n`
        + `async ${extractFn('loadSideSessionMeta')}\nreturn loadSideSessionMeta`,
        { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.None } },
      ).outputText,
    )
    const loadSideSessionMeta = factory(api, sessionStore, realSessionId, sideModelId, sending, hasRealSession) as () => Promise<void>

    // 1) 占位 Tab 转正到 101：发出 GET /sessions/101
    realSessionId.value = 101
    hasRealSession.value = true
    const p101 = loadSideSessionMeta()
    expect(gets.has('/sessions/101')).toBe(true)

    // 2) 同一 Tab 组件实例又被指派给边路会话 202（watcher else-if 分支，不重拉 meta）
    realSessionId.value = 202

    // 3) 101 的响应迟到返回（phase=RUNNING）
    gets.get('/sessions/101')!.resolve({ data: { id: 101, phase: 'RUNNING', modelId: 9 } })
    await p101

    // 期望：迟到响应被丢弃，不写任何 phase
    expect(phaseWrites).toEqual([])
    expect(sending.value).toBe(false)
  })
})
```

### 运行输出

```
phaseWrites = [{"sid":"202","phase":"RUNNING"}] sending = true
 × 会话 101 的在途响应迟到返回时，不得把 101 的 phase 写到会话 202
   → expected [ { sid: '202', phase: 'RUNNING' } ] to deeply equal []
 Test Files  1 failed (1)
      Tests  1 failed (1)
```

---

# 附录 A：子代理探针验证的附带发现（本人未重跑，附完整探针代码与输出）

以下 4 条由并行审查子代理以临时探针实跑验证（探针代码与输出照录），按严重度排序，建议纳入同一修复批次评估。

## A-1【中】auto-consume 消息在提交前窗口被取消后不接力消费队列

- 位置：`backend-ts/src/session/ws/streaming-ws-handler.ts:601-606`（`handleSendMessage` 主路径）；同类未修路径 `:801-810`（`executePersistedUserPrompt`）、`:894-898`（`handleEditAndResend`）；对照 `:749`（`runExecution` finally，CANCELLED 仍消费）。
- 事实：`takePendingCancel` 命中后 `return` 前不调用 `autoConsumeQueue`。既有 spec `streaming-ws-handler.spec.ts:828` `autoConsumesQueueWhenExecutionCancelled` 明确「CANCELLED 属用户主动决策：结束后照常自动消费下一条」——但「提交前窗口取消」（cancel flag 尚未注册、走 `pendingCancels`→`takePendingCancel` 的 M-2 竞态修复路径）收敛终态后不接力，队列剩余消息要等到下一次手动发送/执行结束才可能被消费。
- 触发链：执行中用户连发两条进队列 → 当前执行结束，autoConsume 出队队头并提交带 500ms 延迟窗口的 `handleSendMessage` → 用户在窗口内点「停止」→ 500ms 后 `handleSendMessage` 恢复，`takePendingCancel` 命中 → 落 CANCELLED、`return` → 队列第二条滞留无人接力。
- 探针（`backend-ts/src/session/zz-probe-presubmit-cancel.spec.ts`，驱动真实 handler + fake timers）核心断言 `expect(h.messageQueueService.dequeue).toHaveBeenCalledTimes(2)`，实测输出：

```
 × consumes the next queued message after the pre-submit cancel settles
   → expected "spy" to be called 2 times, but got 1 times
 Test Files  1 failed (1)
      Tests  1 failed (1)
```

## A-2【中】`TaskIndexPanel` 对 `focusedSessions` 二次排序，丢掉实时 pending 合并 → 待审批任务不置顶

- 位置：`desktop/src/components/task/TaskIndexPanel.vue:265-271`。store 层 `desktop/src/stores/session/list.ts:63-84` 已按 `Math.max(tree*, 实时 sessionPendingApprovals/Questions)` 排序（注释：「保证主会话待审批 / 待回答在事件到达的瞬间即可升到优先级 0」），组件层又用只读 VO 字段的 `sessionToFocusCandidate` 重排一遍，把这份实时合并抹掉。
- 触发链：`tool_approval` 帧到达 → `incrementPendingApproval('200')`；此时会话 VO 的 `pendingApprovalCount` 仍是 0 → 待审批会话不置顶（实测 `panelOrder: ['100','200']` vs 预期 `['200','100']`）。
- 探针（`desktop/src/components/task/zz-probe-c-focus-resort.test.ts`，真实 session store）实测输出：

```
AssertionError: expected { storeOrder: [ '200', '100' ], …(2) } to deeply equal { …(2) }
  { "panelOrder": [ "100", "200" ], "realtimePendingApproval": 1, "storeOrder": [ "200", "100" ] }
 Test Files  1 failed (1)
      Tests  1 failed (1)
```

## A-3【中】`useChat.prepareAndSendMessage` 发送失败不回滚 `setActiveExecution`，陈旧流门被永久打开

- 位置：`desktop/src/composables/useChat.ts:488`（`setActiveExecution`）+ catch `:495-515`（无 `clearActiveExecution`）。`setActiveExecution` 会 `suppressedStreamSessions.delete(sessionId)`（`useStreamWS.ts:64-68`），失败路径没有任何一处恢复它。
- 触发链：会话此前跑完/被取消过一轮（门已关）→ 用户再次发送，`setActiveExecution` 把门打开并登记一个从未存在的 `eventId` → WS 发送失败（socket 断开 / 15s 重连超时）→ catch 不回滚 → 上一轮执行的迟到 `content_delta`（不带 `executionId`）被接收并新建空气泡 → 幽灵内容。
- 探针（`desktop/src/composables/zz-probe-a-send-fail-gate.test.ts`，真实 `useStreamWS` + FakeWebSocket）实测输出：

```
AssertionError: expected { …(2) } to deeply equal { …(2) }
  { "phantomExecutionStillRegistered": true, "staleFrameAcceptedAfterFailedSend": true }
 Test Files  1 failed (1)
      Tests  1 failed (1)
```

## A-4【低】导出超过 200 页（10000 轮）静默截断，无错误、无截断标记

- 位置：`backend-ts/src/session/session-export.service.ts:44-56`（`loadAllMessages` 硬上限 200 页 × 50 轮）。
- 事实：循环跑满 200 页后自然结束，只导出最新 10000 轮；头部无任何 `truncated` 字段，消费方无法感知丢失。注：该循环自 Markdown 导出版本起未变（`aadfeda5` 只改了渲染），属遗留限制。
- 探针（`backend-ts/src/session/zz-probe-export-fullstack.spec.ts` 用例 H，全栈 fake Db + 真 SessionExportService）实测输出（通过即证明截断行为）：

```
 ✓ H: 超过 200 页（10000 轮）时静默截断，无错误也无截断标记  348ms
 Test Files  1 passed (1)
      Tests  8 passed (8)
```

---

# 附录 B：已排查、探针或既有单测确认干净的区域

避免重复排查，以下区域本轮有实测覆盖且未发现问题：

- **计价公式与迁移等价性**：3000 组随机价格/token 组合与独立 BigInt 有理数参考实现对拍 0 偏差；`cacheRead = min(cached, prompt)`、`cacheWrite = min(creation, prompt-cacheRead)`、`nonCached` 三段钳位与「某 token 类 >0 但价为 NULL → 整行 NULL」正确；V141 迁移（`price_cache_read = ROUND(price_input*0.5,6)`、`price_cache_write = price_input`）对 OpenAI/Anthropic 两种 usage 形状全组合与 V138 旧口径逐项相等；快照/兜底两路径结果一致。
- **admin 成本聚合**：`summary / overview / trendsScope / modelsScope` 四口径 `totalCost` 相等；per-user/per-agent 分项之和等于总计；5 处聚合 SQL 形状正确；预算域单位（COST=micros、TOKENS 原始值）与 GLOBAL→USER→AGENT 优先级、WARN 去重键、`monthStartLocal` 均正确。
- **JSONL 导出行结构**：压缩归档与导出共用 `toMessageJsonlLine`，逐行比对一致；导出处分页完整（120 轮跨 3 页无重复无跳号）、删除过滤、边路排除、文件变更挂载、码点截断与 `filename*=UTF-8''` 均正确（`session-share.spec.ts` 24 例等既有单测全绿）。
- **`MessageQueueService.moveToIndex` 的 `sort_order` 算术**：clamp 收敛、稠密重排、跨会话隔离、`enqueueHead` 不撞号等 10 例全过。
- **WS `handleReorderQueueMessage`**：`moveToIndex` 抛错时 finally 仍推送 `queue_updated` 收敛；跨会话 queueId 前置拒绝；非整数/负 `targetIndex` 拦截。
- **上下文容量 token 记账**（`context-window.ts`）：largest-remainder 分摊 + 余数补给最大分节，9 组手算用例全等；`persistedContextWindow` 只还原 `estimated`。
- **`chatMessage.ts` 映射**：`approvalMark`/`resultTruncated`/乱序 TOOL 结果/未知角色归一等 9 例全过；实时通道 `toolResultMeta` 两处调用点均显式补齐 `resultTruncated`。
- **既有评审已记录/已修复的问题未复现**：审批规则（`2026-10-08-approval-rules-review.md` 3 条）、开放接口（4 轮 3 条）、会话分享（3 轮）、Agent 资产包（5 轮）、任务收件箱（4 轮）、长期记忆（round1）、context-inspector（3 轮）、feishu 合并转发（3 轮）报告的问题在当前代码均已修复；本轮在其范围内未发现新问题。

---

# 备注

1. 本文所有探针均为新建临时 spec 文件、实跑后即删除（`git status` 复核：产品源码与既有 spec 零改动）；每条探针完整源码已附在对应 BUG 节内，可复制后直接运行复现。基线：`backend-ts` `src/session`+`src/harness/core`+`src/usage` 41 files / 651 tests 全绿；`desktop` `src/components/chat`+`src/stores` 存量全绿。
2. BUG-2 的修复需要区分两个窗口：触发阈值用会话模型窗口（`context.modelConfig`，与 `agent-loop.ts:491` mid-loop 门同口径），溢出保护用压缩模型窗口；建议 orchestrator 把会话模型配置一并传入。BUG-1 的最小修法是把 `suppressAutoConsumeSend.delete(sessionId)` 的回收移回覆盖全部早退分支的结构（恢复 `e6d6f8fb` 之前的覆盖语义）。BUG-7 建议在 `useChat.ts:922`/`useStreamWS.ts:112` 灌入时把 id 归一为字符串（与 `QueueMessage` 类型声明对齐），并补一条桌面回归用例。BUG-8 建议仿 `fetchSourceSessionMeta` 加 `fetchedSideMetaId` 守卫。BUG-4 建议 `create-app.ts:1421` 补 `id: model.id`（与同链路 5 处构造对齐）。
