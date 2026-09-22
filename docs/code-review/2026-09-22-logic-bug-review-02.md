# 核心功能逻辑 BUG 审查（2026-09-22 12:40）

- **基线**：`main` @ `30c81cff`（feat: release version 0.0.179）
- **范围**：子代理崩溃恢复与投递、后台子代理收尾、定时任务触发、微信入站与桌面执行互斥、飞书失败重试后的队列接力
- **判定口径**：只收录「在可描述的输入 / 时序下，行为与同文件注释或同路径既有实现的明确意图不符，且会产生用户可感知的错误结果」的问题。风格、性能、命名不计。
- **方法**：按引擎、通道、调度分区读当前源码，并回读对照路径（飞书入站、`updateTerminal`、0.0.179 的提交拒绝回滚）后再收录。`2026-09-22-logic-bug-review-01.md` 的 B01–B07 已随 0.0.179 修复，不重复列入。
- **边界**：没有逐行读完仓库所有测试与前端页面。下面每条都回读了当前源码；未跑真实 MySQL / 浏览器 / 外部 IM。

## 问题总览


| 编号  | 级别  | 模块               | 一句话                                          |
| --- | --- | ---------------- | -------------------------------------------- |
| B01 | P1  | harness/delegate | 父会话恢复先补「工具结果丢失」占位，再投递，真实子代理结果被跳过             |
| B02 | P1  | weixin + harness | 微信入站不取消桌面正在跑的循环，两边同时写同一个会话                   |
| B03 | P1  | schedule         | 暂停发生在真正开跑之前时，本次触发已被推进到下一档且不回滚                |
| B04 | P1  | schedule         | 用过期 cron / once 快照决定下次触发，循环任务改计划后仍按旧档跑或被提前完结 |
| B05 | P1  | harness/delegate | 后台子代理正常收尾用无条件更新，能把已取消的执行改回完成                 |
| B06 | P1  | harness/delegate | 父会话已终态的恢复只改执行行，子会话阶段一直停在运行中                  |
| B07 | P2  | feishu           | 失败卡「重试」成功后不排空忙碌期间进队的消息                       |


---



## B01 [P1] 崩溃恢复用占位工具结果占住投递，父会话读不到子代理真实输出

**位置**：`backend-ts/src/harness/delegate/subagent-recovery-coordinator.ts:60-65`；判定 `backend-ts/src/harness/delegate/subagent-result-delivery.service.ts:63-102`；占位写入 `backend-ts/src/session/session.service.ts:902-905`。占位文案在 `backend-ts/src/harness/core/message-history-normalizer.ts:6-7`。

恢复一组子代理时，顺序是先清理父会话不完整的工具尾巴，再 `deliver`：

```ts
// subagent-recovery-coordinator.ts:60-65
const compaction = await this.compactionService.loadValidated(parentId);
const boundary = this.compactionService.boundaryOf(compaction);
await this.sessionService.cleanupIncompleteTailAfterId?.(parentId, boundary);
for (const execution of [...executions].sort((a, b) => (a.id ?? 0) - (b.id ?? 0))) {
  if (execution.id != null) await this.deliveryService.deliver(execution.id);
```

`cleanupIncompleteTailList` 给每个没有 TOOL 消息的 tool call 插入：

`[系统] 该工具调用没有对应输出（执行中断或结果未保存）。请勿假定已成功；如仍需要请重试。`

`deliver` 只在「助手消息 + 同 id 的 TOOL 消息」缺一才拆掉旧对、写入子代理真实结果。两边都在就只把 `delivery_status` 标成 `DELIVERED`：

```ts
// subagent-result-delivery.service.ts:64-68
const existing = await this.findMessagePair(tx, parentSessionId, toolCallId);
// ...
if (!existing.complete) {
  await this.removeIncompletePair(tx, parentSessionId, toolCallId);
```

`findMessagePair` 的 `complete` 是「助手行和 TOOL 行都非空」，不看 TOOL 内容是不是占位符（同文件 `:249`）。

**触发条件**：父会话已经把带 `delegate` tool call 的 ASSISTANT 落库，子代理还在跑或刚跑完，TOOL 结果还没写入，进程重启。这是委托执行里最长的崩溃窗口。

**错误结果**：父会话历史里该次委托的工具输出是「结果丢失」占位符。`deliver` 认为配对已经完整，不再写入 `execution.result`。随后 `recoverParent` 让父代理接着跑，模型按「子代理没成功」继续，而子会话里其实已有结论。投递状态却是 `DELIVERED`，下次恢复不会再补。

**正确预期**：投递应先于占位，或把占位符视作不完整配对并替换。`deliver` 自己的 `!existing.complete` 分支就是在重建真实结果；清理尾巴不应先把这条路堵死。

**确信依据**：两段代码对「怎样才算已有工具结果」的定义冲突。清理函数插入任意 TOOL 行，投递函数见到任意 TOOL 行就放弃重建。

---



## B02 [P1] 微信新消息不取消桌面端正在执行的同一会话

**位置**：`backend-ts/src/weixin/agent-inbound-handler.ts:100-101`、`:161`、`:221-226`。覆盖点 `backend-ts/src/harness/core/agent-loop.ts:73-76`。循环是否停下 `agent-loop.ts:91-101`。对照：飞书 `backend-ts/src/create-app.ts:1456-1458` 与 `backend-ts/src/feishu/agent-inbound-handler.ts:446-456`。

微信入站拿到会话后立刻：

```ts
// agent-inbound-handler.ts:100-101
const generation = this.nextGeneration(sessionId);
this.abortRunningExecution(sessionId, userId);
```

`abortRunningExecution` 只置微信 handler 自己的 `cancelFlags`，并关掉该会话的 shell。桌面端 `StreamingWsHandler` 跑起来的循环不在这个 Map 里，`agentLoop.requestCancel` 也不会被调用。

真正开跑时又向 AgentLoop 注册一把新旗标，直接盖掉 Map 里原来的那把：

```ts
// agent-loop.ts:73-76
registerCancelFlag(sessionId: number): AtomicBoolean {
  const flag = new AtomicBoolean(false);
  this.cancelFlags.set(sessionId, flag);
  return flag;
}
```

桌面循环持有的是旧旗标对象。`isCancelled` 先看 `context.cancelFlag`（旧对象，仍为 false）。数据库阶段要是 `COMPLETED` 也不当停止条件——`isTerminalPhaseInDb`（`:107-111`）只认 `FAILED` / `CANCELLED`。

两边的会话锁也不是同一把：微信用 handler 自己的 `sessionLocks`（`agent-inbound-handler.ts:69`），桌面用 `StreamingWsHandler` 自己的 `sessionLocks`（`streaming-ws-handler.ts:154`）。微信不会等桌面执行结束。

**触发条件**：用户在桌面打开微信 Bot 会话（`projectKey = weixin-bot`）并且本轮还在跑；此时微信又收到一条新消息。反向不会发生：桌面 `handleSendMessage` 看到阶段已是运行中会拒绝再开一轮。飞书入站在忙时入队，并且 `onInterruptRunning` 会 `agentLoop.requestCancel`。微信两条都没有。

**错误结果**：两个 Agent 循环同时往同一会话写消息、改阶段。回复互相覆盖，桌面和微信各看到一段对不上的历史。后结束的那次 `updatePhase` 决定界面上的终态。

**正确预期**：与飞书一致。已有执行时先取消 AgentLoop 上那把旗标并等它退出，或把新消息入队；不要在旧旗标还被桌面循环持有时换一把新的再并行 `execute`。

**确信依据**：飞书同仓库已经按「忙则入队 + 取消 AgentLoop」实现。微信 `abortRunningExecution` 的旗标来源和锁都是另一套。

---



## B03 [P1] 定时任务在确认会跑之前就吃掉本次触发，暂停后不补跑

**位置**：`backend-ts/src/schedule/scheduled-task.service.ts:272-298`。恢复条件 `updateTask` `:218-224`。对照回滚 `executeTask` `:410-420`。到期查询 `scheduled-task.store.ts:68-72`（`status = 'ACTIVE' AND next_fire_time <= now`）。

`executeTask` 在提交执行池、拿到会话锁、重读状态之前，就用当前 cron 算出下一档并落库：

```ts
// scheduled-task.service.ts:272-274
const nextFireTime = this.calculateNextFireTime(task.cronExpression!);
task.nextFireTime = nextFireTime;
await this.store.updateById({ id: task.id!, nextFireTime });
```

拿到锁之后如果任务已暂停或已删除，直接 `return`。`countThisRun` 仍是 false，后面的收尾不会改 `nextFireTime`：

```ts
// scheduled-task.service.ts:296-298
if (task.status != null && task.status !== 'ACTIVE') {
  return;
}
```

0.0.179 只在执行池拒绝提交时把 `nextFireTime` 还回本次档期（`:414-416`）。暂停 / 删除这条提前返回没有同样的回滚。

`updateTask` 把状态改回 `ACTIVE` 时，只有 `nextFireTime == null` 才重算下一档（`:218`）。被提前推进过的时间不是 null，恢复后不会把本次档期要回来。

**触发条件**：任务已到期并进入 `executeTask`，但回调还在执行池队列里，或正等同一会话上一轮定时执行的 `withSessionLock`（锁会盖住整段 Agent 运行）。这段时间里用户把任务改成 `PAUSED`。

**错误结果**：这次没有执行，`lastExecutionStatus` 也不会记失败。`nextFireTime` 已经是下一档。每天一次要等到明天；固定月日的一次性 cron 要等到明年。用户再点启用，界面仍是启用，但今年 / 今天不会再响。

**正确预期**：与池满拒绝相同。还没进入执行（没入队、没 `updatePhase(RUNNING)`）就因暂停或删除放弃时，把 `nextFireTime` 还回进入 `executeTask` 之前的值。暂停期间 `listDue` 本来就会跳过非 `ACTIVE`，不需要提前推进。

**确信依据**：`previousNextFireTime` 已经在 `:268` 存下来，却只用于池满回滚。暂停分支在写完下一档之后返回，注释写的「拿到锁后重读」没有把这次未发生的触发撤掉。

---



## B04 [P1] 重读到的新 cron / once 不影响已经写下去的下次触发

**位置**：提前推进 `scheduled-task.service.ts:272-274`；重读 `:291-295`、`:321-326`；成功收尾 `:392-402`。用户改计划 `updateTask` `:205-217`（会按新 cron 重写 `nextFireTime` 和 `once`）。

### 触发一：改 cron 后仍按旧档期触发

`executeTask` 开头用的是 `listDue` 当时的 `task.cronExpression`，不是库里的最新表达式。它只更新 `next_fire_time` 一列，所以用户刚改过的 cron 表达式还在，但下一档被旧表达式盖掉。

等锁期间会把 `task.cronExpression` 换成最新值（`:293`）。执行成功后的收尾确实用最新 cron 算了一次 `next`，但只在「算不出下一档」或 `once === 1` 时写入；循环任务的 `patch` 不含 `nextFireTime`：

```ts
// scheduled-task.service.ts:393-400
if (latest != null && latest.status === 'ACTIVE') {
  const next = this.calculateNextFireTime(latest.cronExpression ?? task.cronExpression!);
  if (next == null || latest.once === 1) {
    patch.finished = 1;
    patch.finishedAt = now;
    patch.nextFireTime = null;
  }
}
```

**触发条件**：扫描读到任务之后、`:274` 落库之前或与之交错，用户把「每天 9 点」改成「每小时」。`updateTask` 已把下一档写成大约一小时后，随后被旧 cron 的「明天 9 点」覆盖。

**错误结果**：库里的表达式已是每小时，实际仍要等到旧的下一档才跑。文件头注释（`:270-271`）写明不能用 T0 快照盖掉扫描之后用户对 cron 的修改；这次只写了 `nextFireTime`，效果仍是用旧 cron 盖掉新计划。

### 触发二：把一次性改成循环后，入队路径仍把任务完结

忙会话入队时重读了 `latest`，但没有 `task.once = latest.once`。完结条件是两边取或：

```ts
// scheduled-task.service.ts:321-326
if (latest.once === 1 || task.once === 1) {
  patch.finished = 1;
  patch.finishedAt = enqueuedAt;
  patch.nextFireTime = null;
```

**触发条件**：`once = 1` 的任务到期，会话正忙，于是要入队。拿到锁之前用户把 `once` 改成 false（或把固定月日 cron 改成每天，`updateTask` 会把 `once` 写成 0）。

**错误结果**：`latest.once` 已是 0，内存里的 `task.once` 仍是 1。任务被标 `finished = 1` 且 `nextFireTime = null`。用户要的循环计划只入队这一次，之后永远不再触发。

**正确预期**：锁内决定下一档和是否一次性时只看刚读到的 `latest`。循环任务应把按新 cron 算出的 `next` 写回；`once` 以 `latest.once` 为准。

**确信依据**：`updateTask` 在 0.0.179 已按新 cron 重判 `once` 并重写 `nextFireTime`。`executeTask` 开头那次增量写和入队条件仍用触发前的快照，收尾又不把循环任务的新下一档写回去。

---



## B05 [P1] 后台子代理收尾可以覆盖父会话已经取消的结果

**位置**：`backend-ts/src/harness/delegate/background-subagent-manager.ts:620-632`。条件更新 `subagent-execution.mapper.ts:104-115`（`WHERE status IN ('RUNNING','RECOVERING')`）。对照 `completeRetry` `:312-322` 与 `cancelAllForParent` `:354-361`。

父会话取消时，`cancelAllForParent` 用 `updateTerminal` 把仍在跑的执行改成 `CANCELLED` + `SUPPRESSED`，并 `finishSubagent(..., 'CANCELLED')`。注释写明：子代理若已在窗口内完成，不得覆盖终态。

子代理自己的成功 / 失败 / 取消收尾却是无条件 `updateById`：

```ts
// background-subagent-manager.ts:620-629
await this.deps.subagentExecutionMapper.updateById(execution.id, {
  status,
  result: resultText,
  totalRounds: subContext.currentRound,
  // ...
  completedAt: nowSql(),
});
```

随后 `finishSubagent` 把子会话阶段写成这次的 `status`（`:631`）。`onCompleted`（`:683-690`）若发现 `deliveryStatus === 'SUPPRESSED'` 会跳过结果入队，但**不会把已经被改掉的** `status` **改回去**。

**触发条件**：用户停止父会话（桌面 `abortSubagentChildren` → `cancelAllForParent`）的同时，后台子代理刚好跑完，进入 `:620`。`updateTerminal` 已成功把行写成 `CANCELLED`，随后 `updateById` 再写成 `COMPLETED` 或 `FAILED`。

**错误结果**：执行记录和子会话阶段变回完成或失败，和「已随父会话取消」不一致。`check_subagent` / 子代理面板显示跑完了。若 `onCompleted` 读到 `SUPPRESSED` 之前的 `PENDING`，完成结果还会推进父代理；父代理在用户已经停止之后仍可能吃到这条结果。`completeRetry` 有单测锁住「并发取消之后不得覆盖」（`background-subagent-manager.spec.ts` 中 `completeRetry keeps db state when a concurrent cancel already converged`）。正常跑完这条路径没有同样的守卫。

**正确预期**：与 `completeRetry` / `cancelAllForParent` 一样走 `updateTerminal`。条件不满足就保持 `CANCELLED`，不要 `finishSubagent` 成完成，也不要入队。

**确信依据**：同一文件里重试收尾和取消都改用了条件更新，并写了为什么。`runBackground` 仍调用无 WHERE 的 `updateById`。

---



## B06 [P1] 父会话已结束时，恢复把子执行标取消，子会话却继续显示运行中

**位置**：`backend-ts/src/harness/delegate/subagent-recovery-coordinator.ts:43-45`、`:56-58`；`suppressForParent` 在 `subagent-result-delivery.service.ts:184-194`。另一出口 `subagent-execution-recovery.service.ts:35-39`。对照 `background-subagent-manager.ts:364-368`（`cancelAllForParent` 会 `finishSubagent`）。

`listRecoveryCandidates`（`subagent-execution.mapper.ts:85-91`）只要求投递状态是 `PENDING`，不看父会话阶段。父会话已经是 `COMPLETED` / `FAILED` / `CANCELLED` 时，`recoverGroup` 直接：

```ts
// subagent-recovery-coordinator.ts:43-45
if (!parent || isTerminal(parent.phase)) {
  await this.deliveryService.suppressForParent(parentId);
  return;
}
```

`suppressForParent` 只更新 `subagent_execution`（投递改为 `SUPPRESSED`，运行中的行改为 `CANCELLED`）。不调用 `finishSubagent`，也不 `updatePhase`。`recover` 里父会话已终态的早退同样只 `updateTerminal`，然后 `return`（`subagent-execution-recovery.service.ts:35-39`）。

同一次 UPDATE 还有第二处写错。MySQL 单表 `SET` 从左到右赋值，后面的表达式看得到前面的新值：

```sql
-- subagent-result-delivery.service.ts:188-191
SET delivery_status = 'SUPPRESSED',
    status = CASE WHEN status IN ('RUNNING', 'RECOVERING') THEN 'CANCELLED' ELSE status END,
    completed_at = CASE WHEN status IN ('RUNNING', 'RECOVERING') THEN ? ELSE completed_at END
```

`status` 先被写成 `CANCELLED` 之后，`completed_at` 的 `CASE` 读到的已不是 `RUNNING` / `RECOVERING`，完成时间保持 `NULL`。

**触发条件**：进程在「父会话已落终态、子会话阶段仍是 `RUNNING`、执行行投递仍是 `PENDING`」时退出。例如父会话取消与 `finishSubagent` 之间崩溃，或父会话先失败、子执行还没被收尸。重启后恢复扫描会命中这组。

**错误结果**：执行记录已是取消且不再投递，子会话 `phase` 仍是 `RUNNING`。桌面重新打开后，子代理一直显示执行中，没有停止时间。没有循环在跑，停止按钮也取消不掉一个已经不在内存里的 flag。用户只能看到一个停不下来的子任务。

**正确预期**：与 `cancelAllForParent` 一样把子会话收到 `CANCELLED`（`finishSubagent` 或至少 `updatePhase`），并在 `status` 仍是旧值时写入 `completed_at`（用改写前的状态，或拆成两条语句）。

**确信依据**：`suppressForParent` / `recover` 的早退都没有会话阶段写入。`cancelAllForParent` 有。MySQL 官方对 `UPDATE t SET col1 = ..., col2 = col1` 的说明是右侧看到的是已更新的 `col1`。

---



## B07 [P2] 飞书失败重试成功后，排队消息一直不执行

**位置**：`backend-ts/src/feishu/agent-inbound-handler.ts:217-225`、`runRetry` `:231-289`。正常成功会排空：`executeWithSession` `:473-477` → `flushAttachmentsAndDrain`。`onExecutionFinished` 接线 `backend-ts/src/create-app.ts:1551-1558` 只 `finishExecution` 并在非失败时删进度卡，不排空队列。

失败卡「重试」把 `runRetry` 丢到后台，结束时只清 `busy`：

```ts
// agent-inbound-handler.ts:217-225
void this.runRetry(sessionId, progress)
  .catch(...)
  .finally(() => {
    this.busy.delete(sessionId);
    this.interrupted.delete(sessionId);
  });
```

`runRetry` 在完成或取消时调用 `onExecutionFinished`，然后返回。没有 `drainNextIfPending` / `drainNext`。

正常一条飞书消息跑完且不是 `FAILED` 时，会 `flushAttachmentsAndDrain`，把忙碌期间入队的下一条认领并执行（`:509-514`、`:546-548`）。本轮 `FAILED` 故意不排空，避免沿着失败上下文自动继续。重试把会话从失败跑回 `COMPLETED` 之后，这个「不要继续」的理由已经不成立，排空却没有接上。

**触发条件**：

1. 飞书任务还在跑时又来了消息，消息进入飞书队列。
2. 本轮以 `FAILED` 结束（按设计不自动消费队列）。
3. 用户点失败卡「重试」，重试跑完并成功。

**错误结果**：重试的回复已经在飞书里，之前排队的消息仍是待执行。没有新的入站、也没有人再点队列卡片上的执行时，它们不会自己跑。用户看到的是任务已经恢复成功，后面的话却没人处理。

**正确预期**：`runRetry` 在 `COMPLETED` 或 `CANCELLED` 收尾、并且 `busy` 仍由这次重试持有时，按 `executeWithSession` 的方式排空队列。`FAILED` 的重试可以继续不排空。

**确信依据**：全文件里会 `drainNext` 的是入站收尾、`drainNextIfPending` 和插队。`runRetry` 不在其中。`onExecutionFinished` 的实现也没有补上这一步。

---



## 复查后未列入


| 候选                                                                               | 为何不收                                                                                                                                         |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.0.179 已修的飞书提前落取消、LOCAL 子代理无限等、池满跳档、改 cron 不重判 once、重复完成通知、ECP state 时区、多组提问被清空 | 当前源码已与 `2026-09-22-logic-bug-review-01.md` 的修复说明一致，不重复开条目                                                                                    |
| 自动消费在「停止」窗口不回补队首                                                                 | `2026-09-10-code-review-02.md` R2 已记录。当前分支会回写定时任务 `CANCELLED` 并清映射，仍不 `requeueIfClaimed`。和校验失败路径不一致，但是用户主动停止，是否把已落库的那条 USER 放回队列属于产品语义，这次不单列 |
| 微信 `fetchBytes` 不看 HTTP 状态码                                                      | 上一份同日审查已核对并明确不计入                                                                                                                             |
| 飞书登录把空 email 写回用户                                                                | `feishu-auth.service.ts:248` 仍在。2026-08-06 的审查对当时的 Java 实现记过同一行为，这次不另开一条                                                                     |
| 进度卡回调在循环还没停时就换成「任务已取消」                                                           | `card-action.service.ts:135-137` 与 toast「正在取消任务」不一致，也和 0.0.179「先只置 flag」不一致。进度监听仍可能再 PATCH 同一张卡。现象依赖飞书卡片回调与后续 PATCH 的覆盖顺序，这次不单列              |
| `insert_message` 提前返回后队列不再自动消费                                                   | `suppressAutoConsumeSend` 会吞掉被中止那轮的 `autoConsumeQueue`，部分提前返回不再补一次消费。要踩中「中止已结束、suppress 尚未清除」时再点停止，窗口窄，这次不单列                                 |


