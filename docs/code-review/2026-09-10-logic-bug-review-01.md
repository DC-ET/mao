# 核心功能逻辑 BUG 审查报告（2026-09-10）

审查范围：backend-ts（harness 引擎、工具执行、session/WS/队列、调度、权限写路径）、desktop 前端、sdk/embed。方法：主代理通读关键路径 + 多路并行探索；对高严重度项逐一读码复核。已排除 `docs/code-review/` 历史报告中已记录的旧问题（取消丢弃旧形态、edit claim 泄漏、T0 整行回写、glob JS 回退、task_update 竞态、SSE data 空格、useCenterTabs 首实例等）。

本报告**不收录安全类问题**（注入、鉴权绕过、越权、沙箱穿越、账号接管等），只列纯功能/状态机/并发逻辑错误。

严重度：高 = 功能错误 / 状态永久卡死 / 可重复执行错误数据；中 = 特定场景异常或数据丢失；低 = 边缘偏差。

---

## BUG-1【高】`handleInsertMessage` 不校验队列项 `status === 'PENDING'` → 已消费队列项可再次落库执行，并误杀当前任务

- 位置：`backend-ts/src/session/ws/streaming-ws-handler.ts:1032-1061`；`message-queue.repository.ts:26-28`；`message-queue.service.ts:40-46`

`getById` → `findById` **只过滤 `deleted = 0`，不过滤 `status`**：

```ts
// message-queue.repository.ts:26-28
findById(id: number): Promise<MessageQueue | null> {
  return this.db.queryOne(`SELECT * FROM message_queue WHERE id = ? AND ${notDeleted()}`, [id]);
}
```

出队/删除只把 `status` 置为 `'DELETED'`，**不写 `deleted = 1`**。插队入口：

```ts
const item = await this.deps.messageQueueService.getById(queueId);
if (!item || item.sessionId !== sessionId) {   // ← 未检查 item.status === 'PENDING'
  await this.sendQueueUpdated(sessionId, userId);
  return;
}
// 注释声称要防「已消费」，实现未覆盖
this.abortRunningExecution(sessionId, userId);
// 随后无条件 saveMessage + delete + handleSendMessage
```

**触发**：队列项 X 被 autoConsume/上一轮插队消费（`status='DELETED'`, `deleted=0`）后，前端因多标签页/双击/`queue_updated` 延迟对同一 `queueId` 再发 `insert_message` → `getById` 仍返回 → `abortRunningExecution` 杀掉当前任务 → 同内容再次执行。

历史「insert 误杀」修复的是「abort 发生在 queueId 校验之前」；**status 校验缺失**是同路径上的残留逻辑洞。

**修复**：`getById` 后及 `awaitExecutionRelease` 返回后复读并断言 `status === 'PENDING'`；或 `delete` 用 `UPDATE ... WHERE id=? AND status='PENDING'` 条件更新，`affectedRows===0` 则放弃。

---

## BUG-2【高】定时任务在会话 busy 时入队（`QUEUED`）后，没有任何路径在队列真正执行时回写任务状态；`once` 任务可永不 `finished`，且次年还会再触发

- 位置：`backend-ts/src/schedule/scheduled-task.service.ts:255-257, 287-293, 333-351`；消费侧 `streaming-ws-handler.ts` autoConsume 完全不感知 `scheduled_task`

**入口先推进 `nextFireTime`**（一次性 cron 的 next = 明年同日）：

```ts
const nextFireTime = this.calculateNextFireTime(task.cronExpression!);
await this.store.updateById({ id: task.id!, nextFireTime });
```

**busy 时只入队并标 QUEUED，`countThisRun` 保持 false**：

```ts
if (busy) {
  await this.messageQueueService.enqueue(...);
  await this.markTaskResult(task, 'QUEUED');
  return; // countThisRun === false
}
```

**finally 因 `!countThisRun` 直接 return，不写 fireCount / finished / nextFireTime=null**。

而队列后续由 `autoConsumeQueue` → `handleSendMessage` 当**普通 USER 消息**执行，**不回查、不回写** `scheduled_task.lastExecutionStatus` / `finished` / `fireCount`。

**路径 A（once + busy，最严重）**：
1. 一次性任务到点时会话 RUNNING → prompt 入队，`lastExecutionStatus='QUEUED'`，next 已推到明年，`finished` 仍为 0；
2. 队列消息当普通消息跑完——任务行仍停在 QUEUED，`finished` 永不置 1；
3. 次年同日 `listDue` 再次命中 → **once 任务第二次执行**。

**路径 B（周期任务 + busy）**：`lastExecutionStatus` 永久显示「排队中」；`fireCount` 对入队后经队列执行的触发从不累加。

**修复**：入队时绑定 `scheduledTaskId`；autoConsume 成功后 CAS 回写 `QUEUED → COMPLETED/FAILED` 并累加 fireCount；`once` 任务在成功 enqueue 时即应 `finished=1` 并清 `next_fire_time`。

---

## BUG-3【高】autoConsume 500ms 延迟窗口内的「停止」被时间戳过滤误判为陈旧标记而丢弃，任务照常跑完

- 位置：`backend-ts/src/session/ws/streaming-ws-handler.ts:987-1002`（`handleCancel`）、`:285, 387-398`（`handleSendMessage` 时间戳消费）、`:1141-1206`（`autoConsumeQueue` 500ms 延迟）

`autoConsumeQueue` 在占位、出队、落库后，经 `agentExecutor` **延迟 500ms** 再调 `handleSendMessage`（`executionClaimHeld: true`）。此时 `cancelFlags` 尚未注册。

用户在 500ms 窗口内点「停止」：
1. `handleCancel`：`!cancelFlags.has` → `pendingCancels.set(sessionId, T1)` + `finishCancelledSession`（DB phase=CANCELLED）；
2. 500ms 后 `handleSendMessage` 以 `sendStartedAt = T2 > T1` 启动；
3. 消费条件 `pendingCancelAt >= sendStartedAt` 为 **false**（T1 < T2）→ 取消被当作「上次取消的遗留标记」静默清除；
4. `submitExecution` 提交执行，`updatePhase(RUNNING)` 把刚写入的 CANCELLED 覆盖回 RUNNING，Agent 完整跑完。

注释明确写了「autoConsume 的 500ms 延迟窗口」属于 pendingCancels 的目标场景，但时间戳过滤 `>= sendStartedAt` 使该窗口内的取消**必然**落在 sendStartedAt 之前，永远无法被消费——M-2 修复引入的回归。

**修复**：autoConsume 路径在 `handleSendMessage` 入口（或 500ms 延迟结束后、sendStartedAt 赋值前）先消费 `pendingCancels`；或将 sendStartedAt 提前到 `autoConsumeQueue` 提交延迟任务时记录。

---

## BUG-4【中】`assignRoles` / `assignPermissions`「先删后插」无事务，且最后管理员保护与写入分离（TOCTOU）→ 可清空全部 ADMIN

- 位置：`backend-ts/src/permission/permission.service.ts:66-81, 119-142`；`user/user.service.ts:81-87`

```ts
async assignRoles(userId: number, roleIds: number[]): Promise<void> {
  await this.userRoleRepo.deleteByUserId(userId);  // 非事务
  for (const roleId of roleIds) {
    await this.userRoleRepo.insert({ userId, roleId });
  }
}
```

`assertCanChangeRoles` / `assertCanDisableUser` 与后续写入不在同一事务：仅剩管理员 A、B 时并发降级 A/B，两边都看到对方仍是 active admin → 都放行 → 系统失去全部管理员。`assignRoles` 中途失败还会留下「已删未插」的半截状态。

`updateUser` 在 `roleIds: []` 时：`assertCanChangeRoles` 通过 → 用户行已持久化 → `assignRoles` 抛「至少分配一个角色」→ 接口报错但资料/状态已改。

**修复**：最后管理员检查与角色写入放入同一事务，对 ADMIN 角色绑定行 `SELECT ... FOR UPDATE`；`roleIds` 空数组在持久化前拒绝。

---

## BUG-5【中】`cancelAllForParent` 用无状态守卫的 `updateById` 覆盖已终态执行，可能把 COMPLETED 改写成 CANCELLED 并丢弃结果

- 位置：`backend-ts/src/harness/delegate/background-subagent-manager.ts:338-362`

```ts
const executions = await this.deps.subagentExecutionMapper.listByParent(parentSessionId);
const backgrounds = executions.filter((e) => isAsyncInvocation(e.invocationType) && !isTerminal(e.status));
for (const execution of backgrounds) {
  await this.deps.subagentExecutionMapper.updateById(execution.id, {
    status: 'CANCELLED',
    result: '后台子代理已随父会话取消',
    deliveryStatus: 'SUPPRESSED',
    ...
  });
}
```

`listByParent` 与 `updateById` 之间存在竞态窗口：子代理在此期间正常收尾（写入 COMPLETED + 投递结果）。随后父会话取消触发 `cancelAllForParent`，对同一条 execution 再次 `updateById`：COMPLETED → CANCELLED，deliveryStatus 被强制 SUPPRESSED（即使已 DELIVERED）。

**对照**：同文件 `completeRetry`（L310-319）与 `interruptRunningForCorrection`（L498-511）都用 `updateTerminal` 或「查最新状态再决定」做了 CAS 守卫，唯独 `cancelAllForParent` 漏了。

**修复**：改为 `updateTerminal`（仅 RUNNING/RECOVERING→CANCELLED），或 update 前重查 status 并跳过已终态项。

---

## BUG-6【中】空响应耗尽时 `afterStream` 持久化 promise 被放弃；且空响应轮不发 `onRoundEnd`，前后端回合事件不成对

- 位置：`backend-ts/src/harness/core/agent-loop.ts:245-302`（`onComplete`）、`:325-337`（stream 后 await）、`:341-349`（空响应 `continue`）

**问题 A**：`onComplete` 在空响应计数耗尽前，若 `usage.promptTokens > 0` 会先把 `updateContextAnchor` 推入 `afterStream`。随后 `throw new EmptyResponseExhaustedException()` 发生在流回调内，外层 catch 直接 rethrow，**永远执行不到 `await Promise.all(afterStream)`** → promise 弃置可能 unhandled rejection；即使 resolve，也把「无有效输出」的轮次当成了有效锚点更新。

**问题 B**：每轮开头无条件 `onRoundStart(round)`；空响应路径 `continue` 前**不调用** `onRoundEnd`。前端收到 start(N) 却等不到 end(N)，随后直接 start(N+1)，依赖 start/end 配对的 UI 状态错乱。

**修复**：空响应决定 throw 前不 push afterStream，或 catch 里 `Promise.allSettled` 后再 rethrow；空响应 `continue` 前补 `onRoundEnd`。

---

## BUG-7【中】并行工具调用下 `edit_file`/`write_file` read-modify-write 竞态，丢失编辑

- 位置：`backend-ts/src/harness/core/agent-loop.ts:516`；`harness/tool/impl/edit-file-tool.ts:67-77`；`write-file-tool.ts`

`executeToolCalls` 对多工具用 `Promise.all` **真并行**执行。两个 `edit_file` 改同一文件时：各自 `readFileSync` 同一旧内容 → 各自替换 → `writeFileSync` 先后落盘 → 后写覆盖前写，第一处编辑静默丢失；`file_change`/diff 摘要也基于各自旧快照。

**对照**：shell 侧对同会话命令有 `acquireCommand` 串行锁，文件工具完全没有对应保护。

**修复**：按文件路径加锁（与 shell 同模式），或对同 path 的写工具强制串行。

---

## BUG-8【中】MCP `connectAndListTools` 重连时旧客户端被覆盖且不关闭 → stdio 子进程泄漏；`clientTimeoutSeconds` 从未使用，MCP 挂死拖死整轮

- 位置：`backend-ts/src/harness/mcp/mcp-client-manager.ts:24-35, 37-48, 96-101`

`map.set(server.id!, client)` 直接覆盖已有条目，旧 STDIO 子进程从不 `close()`。`callTool` 无任何 timeout；构造参数 `clientTimeoutSeconds = 120` 全类零引用。CLOUD 下 MCP 服务器挂起 → `Promise.all` 整轮工具执行悬挂。HTTP SSE 回退的 try/catch 包住的是「构造」而非「连接」，`SSEClientTransport` 为不可达代码。

**修复**：覆盖前 close 旧客户端；`callTool` 加超时 race；SSE 回退改到 connect/listTools 阶段。

---

## BUG-9【中】Desktop：SideChatPanel 首次发送无同步互斥，双击/双 Enter 会创建两个边路任务

- 位置：`desktop/src/components/chat/SideChatPanel.vue:515-631`

防重守卫只检查 `sending`，而 `sending.value = true` 要到所有异步步骤完成之后才设置。首次发送路径需经过多次 `await`（connect、uploadImages 等），双击会两次进入并两次 `createSideSession` → 产生孤儿边路会话。

**对照**：主聊天 `useChat.prepareAndSendMessage` 在任何 `await` 之前就同步置位 `sending`。

**修复**：在任何 await 之前同步置位互斥标志（对齐主聊天）。

---

## BUG-10【中】Desktop：主聊天发送失败后乐观用户消息不回滚，产生幽灵消息并可导致重复发送

- 位置：`desktop/src/composables/useChat.ts:375-417`

乐观插入用户消息后若 `wsSendMessage` 失败，catch 只移除尾部空 assistant 占位，**不删除刚插入的乐观用户消息**。用户改内容重发成功后，内容不一致时新旧两条用户消息同时展示。

**对照**：SideChatPanel 有专门的 `rollbackOptimisticMessages`，主聊天缺失。

**修复**：发送失败路径调用与 SideChatPanel 一致的乐观消息回滚。

---

## BUG-11【中】Desktop：`newSession` / ChatPanel 卸载时全局 `clearPendingApprovals`，会误拒其他上下文（含仍在运行的边路任务/子代理）的待审批

- 位置：`desktop/src/composables/useChat.ts:79-89, 801-817, 918-923`；`ChatPanel.vue:394-405`

`pendingApprovals` 是模块级全局队列。新建任务或路由切到设置页（ChatPanel unmount → cleanup）时清空**全部**审批项并对每项 `respondToolApproval(requestId, false)`——边路任务/子代理仍在等待的 LOCAL 工具审批被凭空拒绝。

**修复**：清理时仅处理当前会话/当前面板的审批项；或改为按 sessionId 作用域隔离队列。

---

## BUG-12【中】Embed：选中文本含 `\n\n---\n\n` 时，`stripContextPrefix` 切错分隔符 → 历史回显与引用块双双损坏

- 位置：`sdk/embed/src/context/collector.ts:67-91, 151-157`

拼装时 `PREFIX_SEPARATOR = '\n\n---\n\n'` 夹在「选中块 + 用户正文」之间，选中原文**未经转义**。`stripContextPrefix` 用全文 `indexOf(PREFIX_SEPARATOR)` 取第一处——选中内部的 Markdown 水平线会被误切，历史回显变成引用残片混进正文。

**修复**：选中内容写入前转义/规范化分隔符，或按偏移切分而非全文 indexOf。

---

## BUG-13【中】Embed：`sameMessageText` 用裸 `endsWith` 后缀匹配 → 重连合并可把「未落库的本地用户消息」误判为已保存并丢弃

- 位置：`sdk/embed/src/core/store.ts:39-42, 91-102`；`controller.ts:758-766`

```ts
function sameMessageText(fetched: string, local: string): boolean {
  if (fetched === local) return true;
  return local.length > 0 && fetched.endsWith(local);
}
```

**触发**：断线重连触发 `reloadHistory`；本地 tail 含未确认用户气泡（内容为短串如 `OK`），历史候选集中恰有一条以 `OK` 结尾的更早消息 → `endsWith` 误命中 → 本地副本被丢弃；`reconcilePendingSaves` 见 `hasLocalUserMessage===false` 认为已落库并清掉 pendingSaves。若服务端其实从未收到该条，消息从 UI 消失且不再有超时提示。

设计意图的 `endsWith` 是为「本地只存用户输入、服务端存带前缀全文」准备的，但缺少左边界断言，短句输入下误伤面大。

**修复**：匹配条件改为 `stripContextPrefix(fetched) === local || fetched === local`，或对 `endsWith` 加左边界断言。

---

## BUG-14【低】`AgentExecutor` 任务 reject 时 unhandled rejection（`void task().finally()` 不消费 rejection）

- 位置：`backend-ts/src/harness/core/agent-executor.ts:27-34`

```ts
const start = (task: () => Promise<void>): void => {
  active += 1;
  void task().finally(() => {
    active -= 1;
    const next = queue.shift();
    if (next) start(next);
  });
};
```

若 `task()` reject，`.finally` 回调仍会跑（active 递减、队列接力），但 rejection 悬空为 unhandled promise rejection。当前主要调用方在任务体内有 try/catch，正常路径不抛；但 catch 块自身再抛或未来新增未包 try 的任务即触发。

**修复**：`void task().catch(() => {/* 记录日志 */}).finally(() => { ... });`

---

## 复查过、确认无问题的重点项（避免重复排查）

| 方向 | 结论 |
|------|------|
| WS 取消旧形态 / edit claim 泄漏 / autoConsume 丢消息 | 历史已修，本轮不重复报 |
| 队列 enqueue/reorder 事务与死锁重试 | 自洽 |
| 压缩 CAS / context anchor / 三协议流式解析 | 自洽 |
| 前端 WS 首连重连、编辑重发回滚、useCenterTabs | 历史已修 |
| Embed TokenProvider / WsClient 断线对账 / page_tool 授权 | 自洽 |
| 公司 SSO / JWT 类型 / requireOwnedSession | 逻辑自洽（安全面另论） |

---

## 修复优先级建议

1. **高优（功能正确性）**：BUG-1（插队重复执行）、BUG-2（定时任务 once 二次触发）、BUG-3（autoConsume 取消回归）
2. **中优**：BUG-4（最后管理员 TOCTOU / 半截更新）、BUG-5（子代理取消竞态）、BUG-6（空响应 afterStream/回合事件）、BUG-7（并行编辑竞态）、BUG-8（MCP 泄漏/无超时）、BUG-9~11（前端发送与审批）、BUG-12~13（Embed 消息合并）、BUG-14（executor unhandled rejection）
