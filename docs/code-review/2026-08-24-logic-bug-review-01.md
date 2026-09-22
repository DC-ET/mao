# 核心功能逻辑 BUG 审查报告

> 审查日期：2026-08-24  
> 审查范围：backend-ts（harness 引擎、session WS、schedule、tool）、desktop 前端  
> 审查方法：全量阅读源码，逐函数分析数据流与状态机

---

## BUG 1：定时任务 `executeTask` 中 `fireCount` 与 `lastExecutionStatus` 竞态覆盖

**文件**：`backend-ts/src/schedule/scheduled-task.service.ts:141-199`

**现象**：`executeTask` 方法在 `agentExecutor` 回调内部修改 `task` 对象的属性（`lastExecutionStatus`、`lastFireTime`、`fireCount` 等），然后在 `finally` 块中调用 `this.store.updateById(task)` 持久化。但在进入 `agentExecutor` 之前，`task.nextFireTime` 已被提前计算并写入了数据库（第 145-146 行）。而在 `agentExecutor` 内部重读了 `latest` 后，`task.name`、`task.prompt` 等字段被覆盖，但 `task.lastExecutionStatus` 和 `task.fireCount` 在 `finally` 中的写入是以整个 `task` 对象调用 `updateById`，会将之前 `markTaskResult` 设置的 `lastExecutionStatus` 覆盖回 `finally` 块里计算的值。

**关键代码**：
```typescript
// 第 177 行：markTaskResult 设置 lastExecutionStatus = 'COMPLETED'
await this.markTaskResult(task, 'COMPLETED');

// finally 块 (第 189-198 行)：
task.lastFireTime = formatDateTime(new Date());
task.fireCount = (task.fireCount ?? 0) + 1;
if (task.lastExecutionStatus !== 'QUEUED' && ...) {
  task.finished = 1;
  task.finishedAt = ...;
}
await this.store.updateById(task);
```

**问题**：`finally` 块中 `task.lastExecutionStatus !== 'QUEUED'` 的判断条件——如果 `markTaskResult` 已经将 `lastExecutionStatus` 设为 `'COMPLETED'`，但 `finally` 块未重新设置 `lastExecutionStatus`，它仍然是 `'COMPLETED'`。然而，`finally` 块中的 `updateById(task)` 会将整个 `task` 对象写回数据库，如果 `agentExecutor` 回调内部的异步任务尚未完成时，外层的 `inFlight` 守卫已经被 `finally` 释放（第 200-202 行的外层 `finally`），此时下一次 cron 触发可能进入并并发读写同一个 `task` 对象，导致 `fireCount` 计数丢失或 `lastExecutionStatus` 被覆盖。

**影响**：定时任务的执行计数和状态在并发触发场景下可能丢失或不一致，`inFlight` 释放过早（在异步回调完成之前）。

---

## BUG 2：`SessionService.updatePhase` 中 `elapsedMs` 计算使用了 `Date.parse` 但未处理 NaN 回退

**文件**：`backend-ts/src/session/session.service.ts:700-718`

**现象**：`updatePhase` 方法在会话进入终态时计算已耗时 `elapsedMs`，使用以下逻辑：

```typescript
if (session.startedAt != null) {
  const elapsed = Date.parse(session.startedAt.replace(' ', 'T')) 
    ? Date.now() - Date.parse(toIso(session.startedAt)) 
    : 0;
  fields.elapsedMs = (session.elapsedMs != null ? session.elapsedMs : 0) + Math.max(0, elapsed);
  fields.startedAt = null;
}
```

**问题**：`Date.parse(session.startedAt.replace(' ', 'T'))` 作为条件表达式——当 `startedAt` 格式为 `2026-01-01 10:00:00` 时，`replace(' ', 'T')` 得到 `2026-01-01T10:00:00`，`Date.parse` 会返回有效时间戳。但 `toIso(session.startedAt)` 函数做了相同的替换（`sql.includes('T') ? sql : sql.replace(' ', 'T')`），所以这段代码的 **三元运算符条件分支是冗余的**——如果第一个 `Date.parse` 返回 NaN，第二个同样会返回 NaN。这意味着 `elapsed` 永远是 `Date.now() - NaN = NaN`，然后 `Math.max(0, NaN)` 结果是 `NaN`，导致 `elapsedMs` 被设为 `NaN`，最终写入数据库的值可能为 NaN 或被数据库拒绝。

**实际触发条件**：当 `startedAt` 包含无法被 `Date.parse` 识别的格式时（如某些 MySQL 驱动返回的带微秒的字符串 `2026-01-01 10:00:00.123456`），`Date.parse` 在 Node.js 中可能返回 NaN。

**影响**：会话的累计执行时间 `elapsedMs` 可能被设为 NaN，导致前端显示异常或数据库写入失败。

---

## BUG 3：`BackgroundTaskManager.consumeCompletedResults` 遍历 `Map.keys()` 同时删除元素

**文件**：`backend-ts/src/harness/core/background-task-manager.ts:33-56`

**现象**：

```typescript
async consumeCompletedResults(sessionId: number | null): Promise<Record<string, string>> {
  const completed: Record<string, string> = {};
  const now = Date.now();
  for (const taskId of [...this.tasks.keys()]) {  // ← 复制了 keys，OK
    const entry = this.tasks.get(taskId);
    if (!entry) continue;
    if (entry.done) {
      if (sessionId !== entry.sessionId) continue;  // ← BUG
      // ... 添加到 completed
      this.tasks.delete(taskId);
    } else if (now - entry.submitTimeMs > ABANDONED_THRESHOLD_MS) {
      entry.cancelled = true;
      this.tasks.delete(taskId);
    }
  }
  return completed;
}
```

**问题**：当 `entry.done` 为 true 但 `sessionId !== entry.sessionId` 时，代码执行 `continue` 跳过了该条目。这意味着**其他会话的已完成任务永远不会被消费，也无法被清理**。在长时间运行的服务中，如果不同 session 的后台任务交替提交，其他 session 的已完成任务会永远留在 `Map` 中，造成内存泄漏。只有当同一 sessionId 再次调用 `consumeCompletedResults` 时才会清理该 session 的任务，但其他 session 的任务会一直堆积，直到超过 30 分钟的 `ABANDONED_THRESHOLD_MS` 才被清理。

**影响**：`BackgroundTaskManager` 内部 `Map` 中的已完成任务条目不会被及时清理，造成渐进式内存泄漏。在多 session 并发场景下尤其严重。

---

## BUG 4：`ScheduledTaskService.executeTask` 的 `inFlight` 守卫释放早于异步执行完成

**文件**：`backend-ts/src/schedule/scheduled-task.service.ts:148-202`

**现象**：

```typescript
async executeTask(task: ScheduledTask): Promise<void> {
  if (task.id != null && this.inFlight.has(task.id)) {
    return;
  }
  if (task.id != null) this.inFlight.add(task.id);
  try {
    // ... task.nextFireTime 更新与持久化
    this.agentExecutor(() => withSessionLock(task.sessionId!, async () => {
      // ... 异步执行逻辑（可能持续数十分钟）
    }));
  } finally {
    if (task.id != null) this.inFlight.delete(task.id);  // ← 守卫释放
  }
}
```

**问题**：`agentExecutor` 是异步提交（fire-and-forget），`executeTask` 方法在提交后立即进入 `finally` 块释放 `inFlight` 守卫。这意味着 `agentExecutor` 回调还在排队或执行中时，下一次 cron 扫描（60 秒一次）已经可以再次触发同一个 task。虽然 `withSessionLock` 提供了 session 级别的互斥，但 `inFlight` 的设计目的是防止同一 task 在锁等待期间被重复触发（注释说明了这一点），而它实际上并没有实现这个目标。

**影响**：当 cron 表达式的间隔小于任务执行时间时（如 `*/1 * * * *` 但任务需要 5 分钟），会产生多次重复的 `withSessionLock` 排队，每个排队任务都会在锁释放后依次执行，导致同一 prompt 被重复执行多次。虽然 `nextFireTime` 已提前推进，但 `scanAndExecute` 使用的是 `listDue(now)` 查询，不依赖 `nextFireTime` 的值来做在飞守卫。

---

## BUG 5：`AgentLoop.executeToolCalls` 中并行工具调用的 cancel 检查不完整

**文件**：`backend-ts/src/harness/core/agent-loop.ts:414-435`

**现象**：

```typescript
// 并行执行多个工具
const results = await Promise.all(pendingCalls.map((tc) => runOne(tc)));
if (cancelFlag?.get()) return;  // ← 只在全部完成后检查一次
for (let i = 0; i < pendingCalls.length; i++) {
  // ... 处理每个工具结果
}
```

**问题**：当有多个工具调用并行执行时，代码只在 `Promise.all` 全部完成后检查一次 `cancelFlag`。如果用户在其中一个工具执行过程中取消，`Promise.all` 会等待所有工具执行完毕（`runOne` 内部的 `dispatchTool` 不会检查 cancel flag）。这意味着：

1. 用户点击取消后，所有并行工具调用都会继续执行到完成
2. 工具的副作用（如 `write_file`、`shell` 命令）已经产生
3. 取消响应延迟——用户可能等待数十秒才看到取消生效

对比单工具调用路径（第 399-413 行），它在执行前后各检查一次 `cancelFlag`，但并行路径缺少中途检查。

**影响**：并行工具调用场景下取消操作不及时，用户可能在取消后仍看到工具副作用产生。

---

## BUG 6：`StreamingWsHandler.handleAskUserQuestionsResult` 发送多余的 `ask_user_questions_cancelled` 事件

**文件**：`backend-ts/src/session/ws/streaming-ws-handler.ts`（handleAskUserQuestionsResult 方法）

**现象**：

```typescript
const completed = this.deps.askUserQuestionsRegistry.complete(sessionId, requestId, resultJson);
if (completed) {
  const executionId = this.runningExecutionIds.get(sessionId);
  this.deps.registry.send(userId, wsEvent('ask_user_questions_cancelled', sessionId, { requestId }));
  this.deps.registry.send(userId, wsEvent('session_status', sessionId, {
    phase: 'RUNNING',
    ...(executionId ? { executionId } : {}),
  }));
  // ...
}
```

**问题**：当用户正常回答了 `ask_user_questions` 的问题后，`handleAskUserQuestionsResult` 向前端发送了 `ask_user_questions_cancelled` 事件。但这个事件名是"cancelled"，语义上暗示问题被取消，而实际上用户是正常回答了问题。前端收到此事件后会调用 `sessionStore.removeAskQuestion(sessionId, data.requestId)` 来清除问题 UI，功能上可用但语义混乱。

更关键的是：`ToolDispatcher.dispatchAskUserQuestions` 方法（tool-dispatcher.ts）在 `waitForAnswer` 返回结果后也会检查结果是否包含 `"error"` 并发送 `ask_user_questions_cancelled` 事件。这意味着在正常回答场景下，前端可能收到两次 `ask_user_questions_cancelled` 事件——一次来自 `handleAskUserQuestionsResult`，一次来自 `dispatchAskUserQuestions`。

**影响**：前端在用户正常回答问题时收到"cancelled"语义的事件，可能导致 UI 状态不一致或重复处理。

---

## BUG 7：`AgentLoop.mergeToolCall` 中 `findMergeTarget` 对无 ID 无 index 的 delta 的回退逻辑错误

**文件**：`backend-ts/src/harness/core/agent-loop.ts:526-532`

**现象**：

```typescript
private findMergeTarget(existing: ToolCall[], delta: ToolCall): ToolCall | undefined {
  if (delta.id) {
    return existing.find((tc) => tc.id === delta.id);
  }
  if (delta.index != null) {
    return existing.find((tc) => tc.index === delta.index) ?? existing[delta.index];
  }
  return existing.length > 0 ? existing[existing.length - 1] : undefined;
}
```

**问题**：当 delta 既没有 `id` 也没有 `index` 时，代码返回 `existing` 数组的最后一个元素作为合并目标。这个回退逻辑假设无 ID/无 index 的 delta 属于最后一个 tool call。但 LLM 流式 API 中，某些 provider 的 delta 片段可能不携带 id 或 index（特别是 tool calls 的参数分片），如果多个 tool call 同时被流式传输，这些无标识的 delta 会被错误地合并到最后一个 tool call 上，而不是它们实际所属的 tool call。

**影响**：当 LLM 同时返回多个 tool call 的流式 delta 且 delta 片段不携带 ID/index 时，参数可能被合并到错误的 tool call 上，导致工具调用参数错误。

---

## BUG 8：`StreamingWsHandler.withLock` 在异常时可能不释放锁

**文件**：`backend-ts/src/session/ws/streaming-ws-handler.ts`（withLock 方法，文件末尾）

**现象**：

```typescript
private async withLock(map: Map<number, Promise<void>>, id: number, fn: () => Promise<void>): Promise<void> {
  const prev = map.get(id) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((r) => { release = r; });
  map.set(id, prev.then(() => current));
  await prev;
  try {
    await fn();
  } finally {
    release();
  }
}
```

**问题**：`map.set(id, prev.then(() => current))` 设置了一个新的 Promise 链。如果 `prev` Promise reject（即上一个锁持有者异常退出但未调用 `release()`），那么 `await prev` 会抛出异常，但 `release` 函数尚未被调用，`current` Promise 永远不会 resolve/reject。此时 `map.get(id)` 返回的是一个永远 pending 的 Promise，后续所有对同一 session 的操作都会永久卡死。

虽然 `finally` 块中有 `release()`，但如果 `await prev` 本身抛出异常，`release()` 不会被执行（因为异常在 `try` 块之前抛出）。

**触发条件**：如果前一个 `withLock` 的 `fn()` 抛出异常且 `release()` 在 `finally` 中被调用，`prev` 会正常 resolve（因为 `finally` 中的 `release()` 使 `current` resolve）。但如果由于某些极端情况（如进程被强制终止后恢复），`prev` 可能处于 rejected 状态。

**影响**：在极端情况下（如前一个锁链异常），会话可能永久卡死，所有后续操作无法执行。

---

## BUG 9：`useStreamWS.ts` 中 `messageSavedCallbacks` 在组件卸载时未清理

**文件**：`desktop/src/composables/useStreamWS.ts`

**现象**：`messageSavedCallbacks` 是模块级别的 `Map`，`onMessageSaved` 注册回调后返回 callbackId，`offMessageSaved` 用于取消注册。但 `useStreamWS()` 作为 Vue composable 在多个组件中被调用，如果注册了 `onMessageSaved` 的组件被卸载但未调用 `offMessageSaved`，回调会永久残留在 `messageSavedCallbacks` Map 中。

```typescript
const messageSavedCallbacks = new Map<string, MessageSavedCallback>()
// ...
function onMessageSaved(callback: MessageSavedCallback): string {
  const callbackId = `callback_${Date.now()}_${Math.random()...}`
  messageSavedCallbacks.set(callbackId, callback)
  return callbackId
}
```

**问题**：由于 `messageSavedCallbacks` 是模块级单例（不在组件的 setup 作用域内），每次 `user_message_saved` 事件到达时，所有残留的回调都会被遍历执行，包括来自已卸载组件的回调。这可能导致：
1. 对已卸载组件的响应式状态进行操作（Vue 警告或异常）
2. 内存泄漏——回调闭包持有组件引用

**影响**：长时间使用桌面端时，残留的 message saved 回调可能导致内存泄漏和已卸载组件的错误操作。

---

## BUG 10：`CompactionService.invokeAndValidate` 的 `onError` 回调赋值 `streamError` 但未在 `onComplete` 中检查

**文件**：`backend-ts/src/harness/core/compaction-service.ts:99-130`

**现象**：

```typescript
const callback: StreamCallback = {
  onChunk: (chunk) => { /* ... */ },
  onComplete: (u) => { usage = u; },
  onError: (t) => { streamError = t; },
  onStreamReset: () => { /* ... */ },
  // ...
};
await this.llmAdapter.stream(request, modelConfig, callback, cancelFlag);
if (streamError) throw streamError;
this.checkCancelled(cancelFlag);
```

**问题**：`OpenAiLlmAdapter.stream` 的实现中，`onError` 回调被调用后方法直接 `return`（不抛异常），随后 `onComplete` 可能不会被调用。`invokeAndValidate` 在 `stream()` 返回后检查 `streamError`——这是正确的。但如果 `onError` 和 `onComplete` 都被调用了（某些 LLM provider 的行为不确定），`onComplete` 中设置 `usage` 后 `streamError` 也会被设置，最终 `throw streamError` 会丢弃 `usage`。这在压缩场景下不是大问题，但可能导致压缩统计信息丢失。

更关键的是：`onStreamReset` 回调会清空 `content`、`toolCalls` 和 `usage`，但如果 `streamError` 在 `onStreamReset` 之后被设置，`content` 已被清空但 `streamError` 仍然存在——`stream()` 返回后 `throw streamError` 正确地抛出了错误，但 `content` 已丢失，无法用于后续的错误诊断。

**影响**：压缩流程在 LLM 流式错误时的诊断信息和统计信息可能不完整。

---

## BUG 11：`ScheduledTaskScheduler.scanAndExecute` 每分钟全量扫描可能重复执行

**文件**：`backend-ts/src/schedule/scheduled-task.service.ts:340-364`

**现象**：

```typescript
start(): void {
  void this.scanAndExecute();
  this.timer = setInterval(() => { void this.scanAndExecute(); }, 60_000);
}

async scanAndExecute(): Promise<void> {
  const dueTasks = await this.store.listDue(formatDateTime(new Date()));
  // ...
  for (const task of dueTasks) {
    try {
      await this.service.executeTask(task);
    } catch (e) { /* ... */ }
  }
}
```

**问题**：`scanAndExecute` 不在运行时防止重叠。如果某次扫描执行耗时超过 60 秒（例如数据库慢查询或 `executeTask` 中大量异步操作），下一次 `setInterval` 触发时会启动第二个 `scanAndExecute`，两个扫描可能同时处理相同的 `dueTasks`。`executeTask` 内的 `inFlight` 守卫已在 BUG 4 中指出存在释放过早的问题，两个并发的 `executeTask` 调用可能同时通过 `inFlight` 检查。

**影响**：同一定时任务可能被并发执行两次，产生重复的 Agent 执行和消息写入。

---

## 总结

| 编号 | 模块 | 严重程度 | 影响范围 |
|------|------|----------|----------|
| BUG 1 | schedule | 中 | 定时任务计数与状态不一致 |
| BUG 2 | session | 中 | 会话执行时间显示为 NaN |
| BUG 3 | harness/core | 中 | BackgroundTaskManager 内存泄漏 |
| BUG 4 | schedule | 高 | 定时任务重复执行 |
| BUG 5 | harness/core | 中 | 并行工具调用取消不及时 |
| BUG 6 | session/ws | 低 | 前端 UI 状态不一致 |
| BUG 7 | harness/core | 中 | 工具调用参数合并错误 |
| BUG 8 | session/ws | 高 | 会话永久卡死 |
| BUG 9 | desktop | 低 | 内存泄漏与已卸载组件操作 |
| BUG 10 | harness/core | 低 | 压缩诊断信息丢失 |
| BUG 11 | schedule | 高 | 定时任务并发重复执行 |
