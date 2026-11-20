# 核心功能逻辑 BUG 审查（2026-09-22 11:35）

- **基线**：`main` @ `8a1ff627`（feat: release version 0.0.178）
- **范围**：`backend-ts/src/` 引擎与通道（harness 循环 / 子代理恢复 / 定时任务 / 飞书取消 / ECP 登录 / 微信发送）+ `desktop/src/` 提问面板入站
- **判定口径**：只收录「在可描述的输入 / 时序 / 边界条件下，代码行为与同文件注释或同路径既有实现的明确意图不符，且会产生用户可感知的错误结果」的问题。纯风格、性能、命名不计。
- **方法**：按引擎、会话/飞书、鉴权与工具分区读源码，逐条回读调用方与旁路实现后再收录。0.0.177 / 0.0.178 已修复的条目不重复列入。
- **修复状态（2026-09-22）**：B01–B07 已按下文「正确预期」修复，并补了回归测试。原文的「现状」保留审查时的样子。

## 问题总览

| 编号 | 级别 | 模块 | 一句话 |
|---|---|---|---|
| B01 | P1 | feishu | 进度卡「取消」在执行仍在跑时就落 `CANCELLED`，崩溃恢复期会和续跑并行 |
| B02 | P1 | harness/delegate | LOCAL 子代理恢复没有等待期限，桌面未连接时父会话恢复永远不会开始 |
| B03 | P1 | schedule | 线程池拒绝提交时，本次触发已被推进到下一档，当天/当次不再补跑 |
| B04 | P1 | desktop + harness | 多组提问仍被每条事件清空，0.0.178 的「按顺序作答」在入口就被拆掉 |
| B05 | P2 | schedule | 更新 cron 时「按新形态重判一次性」的条件写反，存量任务几乎永不重判 |
| B06 | P2 | harness/delegate | 后台子代理完成通知与投递状态不是同一次写入，崩溃恢复会再插一条 |
| B07 | P2 | auth/ECP | OAuth `expires_at` 用进程本地时区，领取用上海时间比较，UTC 容器上刚签发就过期 |

---

## B01 [P1] 飞书取消在执行还在跑时就写成已取消

**位置**：`backend-ts/src/create-app.ts:1790-1802`（对照守卫：`1462-1465`；落库：`1347-1357`）

注释写的是「重启后续跑尚未挂 flag 时才补写 CANCELLED」：

```ts
// create-app.ts:1790-1802
// 进度卡「取消任务」：置位 AgentLoop / 飞书 handler 取消标志 + 关闭 shell；
// 重启后续跑尚未挂 flag 时补写 CANCELLED，与桌面端输入框停止同语义。
cancelRunning: async (sessionId) => {
  feishuInboundHandler.cancel(sessionId);
  const hadLoop = agentLoop.getCancelFlag(sessionId) != null;
  const persisted = await persistCancelledIfActive(sessionId); // 无条件执行
  if (!hadLoop && persisted) {
    void feishuInboundHandler.drainNextIfPending(sessionId)...
  }
  return hadLoop || persisted;
},
```

同一文件里插队用的 `resolveIdleRunning` 有正确守卫：已有 AgentLoop flag 就只置取消，等执行自己收尾。

```ts
// create-app.ts:1462-1465
resolveIdleRunning: async (sessionId) => {
  if (agentLoop.getCancelFlag(sessionId) != null) return;
  await persistCancelledIfActive(sessionId);
},
```

`persistCancelledIfActive` 在 phase 仍是 `RUNNING` / `RESUMING` 时会立刻 `cleanupIncompleteTail`、`finishExecution(..., 'CANCELLED')`，并删掉进度卡片映射。

**触发条件**：飞书进度卡点「取消任务」，且该会话已经挂上 AgentLoop 取消标志。最严重的是崩溃恢复续跑：`CrashRecoveryRunner` 只在 `AgentLoop.registerCancelFlag` 上登记，飞书 handler 的 `busy` 集合是空的（`agent-inbound-handler.ts:555-561` 的繁忙判断是「内存 busy **或** phase 为 RUNNING/RESUMING」）。

**错误结果**：

1. 会话立刻变成 `CANCELLED`，进度卡映射被删。循环还在等模型或工具。`TaskTerminalService.finishExecution`（`task-terminal.service.ts:36-40`）见到已是终态就直接返回，恢复循环结束时自己的 `CANCELLED` / `COMPLETED` 写不进去。
2. 恢复路径没有 `busy`。phase 已不是 `RUNNING`/`RESUMING` 之后，`isBusyOrRecovering` 为 false，新的飞书消息会再开一轮执行，和尚未退出的恢复循环打在同一个会话上。
3. `cleanupIncompleteTail`（`session.service.ts:885-905`）会给还没回来的 tool call 补占位 TOOL 消息。真正的工具结果随后再落库，历史里同一轮出现占位和真实结果两套。

**正确预期**：与 `resolveIdleRunning` 和上面的注释一致——`hadLoop === true` 时只 `requestCancel`，等循环收尾再落终态、再删卡片、再排空队列。只有「DB 残留 RUNNING、内存没有 flag」才走 `persistCancelledIfActive`。

**确信依据**：`hadLoop` 算出来了，却只用来决定要不要 `drain`，没有用来跳过落库。旁路 `resolveIdleRunning` 已经按「有 flag 就不落终态」实现。

---

## B02 [P1] LOCAL 子代理恢复没有等待期，父会话恢复被挂死

**位置**：`backend-ts/src/harness/delegate/subagent-execution-recovery.service.ts:70-76`、`128-136`；阻塞点 `subagent-recovery-coordinator.ts:47-54`、`71-72`

```ts
// subagent-execution-recovery.service.ts:128-136
private async waitForLocal(childSessionId: number, cancel: { get(): boolean }): Promise<boolean> {
  while (!cancel.get()) {
    if (await this.localRegistry.isConnected(childSessionId)) return true;
    await sleep(1000);
  }
  return false;
}
```

连不上时抛出的文案是「LOCAL 客户端未在恢复等待期内连接」（同文件第 76 行）。循环里没有截止时间，唯一出口是 `cancel.get()`。

**触发条件**：蓝绿发布或进程重启后，恢复扫描命中 `executionMode=LOCAL` 且仍为 `RUNNING`/`RECOVERING` 的子代理，桌面端还没连上这个 child session（用户没打开客户端，或连的是别的会话）。

**错误结果**：`SubagentRecoveryCoordinator.recoverGroup` 用 `Promise.all` 等全部子执行结束，然后才 `deliver` 和 `recoverParent`。`waitForLocal` 不返回，这一组的父会话恢复不会开始。父会话停在运行中，飞书/桌面侧后续消息只入队。没有人去置这个 child 的 cancel flag 时，空转会一直占着恢复任务。

**正确预期**：文案里的「恢复等待期」应当存在。超时后把该子执行标失败并让 `recoverGroup` 继续，父会话恢复不被单个未连接的 LOCAL 子代理堵住。同仓库 `LocalToolExecutor` 对 LOCAL 工具有明确超时，这里没有。

**确信依据**：错误字符串和循环条件直接矛盾；`recoverGroup` 在子执行全部 settle 之前不会调用 `recoverParent`。

---

## B03 [P1] 定时任务在提交执行池之前就吃掉本次触发

**位置**：`backend-ts/src/schedule/scheduled-task.service.ts:270-275`、`405-408`；扫描补偿 `537-548`。执行器接线：`create-app.ts:818` 把 `agentExecutor.submit` 传进去，池满时 `agent-executor.ts:54` 同步抛 `AgentExecutorRejectedError`。

```ts
// scheduled-task.service.ts:270-275
const nextFireTime = this.calculateNextFireTime(task.cronExpression!);
task.nextFireTime = nextFireTime;
await this.store.updateById({ id: task.id!, nextFireTime });
const executionId = randomUUID();
this.agentExecutor(async () => { /* 真正执行 */ });
submitted = true;
```

`submitted` 只在 `submit` 成功后才置位，说明作者知道提交可能失败：失败时 `finally` 会清掉 `inFlight`。但 `nextFireTime` 已经落库，失败分支不把它改回去。

扫描循环的 catch 会再写一次 `lastExecutionStatus=FAILED`，并用 `calculateNextFireTime`（从「现在」算下一档，不是把本次档期还回来）覆盖 `nextFireTime`。

**触发条件**：`listDue` 命中任务时，Agent 线程池 active 与队列都已满（默认 core 20 / max 100 / queue 200，见 `settings.service.spec.ts` 的默认值）。`submit` 在回调开始前就抛错。

**错误结果**：

1. 这一次到期没有执行。`inFlight` 被清掉，所以不是「还在跑」，而是这次触发被跳过。
2. `nextFireTime` 落到下一档。每天 9 点的任务要等到明天；固定月日的一次性 cron（`isOneShotCron`，下一档是明年同一天）要等到明年，并且 catch 不会把 `finished` 置 1，明年还会再响一次。
3. 界面上 `lastExecutionStatus=FAILED`，但会话里没有这次运行，也没有失败回复。

**正确预期**：与 `StreamingWsHandler.submitExecution`（`streaming-ws-handler.ts:463-466`）一致——提交被拒绝时回滚占位，让任务保持 due，下一轮扫描再试。不应把「没提交出去」记成一次失败触发并跳到下一档。

**确信依据**：`submit` 在队列满时是同步抛错（`agent-executor.ts:54`），发生在 `submitted = true` 之前；`calculateNextFireTime` 用的是 `cron.nextRun()`（相对当前时刻的下一档），不会把刚被推进的本次档期算回来。

---

## B04 [P1] 多组提问仍然只留最后一组

**位置**：`desktop/src/composables/useStreamWS.ts:997-1005`。面板侧已按队列设计：`desktop/src/components/chat/QuestionPanel.vue:132-137`。后端并行派发：`backend-ts/src/harness/core/agent-loop.ts:531`；重连重推：`streaming-ws-handler.ts:292-296`。

```ts
// useStreamWS.ts:997-1005
case 'ask_user_questions': {
  if (sessionId && data) {
    // Clear stale questions — the agent has moved on to a new question
    sessionStore.clearAskQuestions(sessionId)
    sessionStore.appendAskQuestion(sessionId, { ... })
  }
}
```

`appendAskQuestion`（`stores/session.ts:1629-1636`）本身会按 `requestId` 去重并追加。每次事件先 `clearAskQuestions`，队列里永远只有刚到的那一组。

0.0.178 把面板改成取 `items[0]`，并写明「按到达顺序先答最早那组；答完后服务端移除该项，面板接上下一组」。这个修复依赖 store 里能同时放下多组。入口仍在清空。

**触发条件**（两条都能稳定走到）：

1. 同一轮模型并行调用两组 `ask_user_questions`。系统提示允许互不依赖的工具并行（`prompt-engine.ts:64`），`executeToolCalls` 对多个 tool call 使用 `Promise.all`。两组都会 `register` 并各推一条 `ask_user_questions`。
2. 已经有多条 pending 时刷新或重连。`handleSubscribe` 对 `getPendingForSession` 的每一条各发一次事件（`ask-user-questions-registry.ts:75-84` 会返回该会话全部 pending）。

**错误结果**：界面只剩最后一组。更早的 `requestId` 仍在 `AskUserQuestionsRegistry` 里 `waitForAnswer`（默认 15 分钟，`ask-user-questions-registry.ts:3`）。用户无法作答，对应分支一直堵到超时。重连后也一样，不会把多组重新攒回来。

**正确预期**：`ask_user_questions` 只 `append`（同 `requestId` 已由 store 去重）。清空留给终态、取消和 `ask_user_questions_cancelled`。这样 0.0.178 的面板顺序作答才有数据。

**确信依据**：面板注释、CHANGELOG 0.0.178 和 store 的 append 语义都是「队列」；唯一把队列打成单槽的是这个 clear。后端 registry 与订阅重推都按多条 pending 实现。

---

## B05 [P2] 改 cron 不会重判「一次性」

**位置**：`backend-ts/src/schedule/scheduled-task.service.ts:205-209`（创建路径对照：`181-186`）

```ts
// scheduled-task.service.ts:205-209
if (cronExpression != null) {
  this.parseCron(cronExpression);
  task.cronExpression = cronExpression;
  // 未显式指定 once 时，换 cron 后按新形态重判一次性属性
  if (once == null && task.once == null) task.once = isOneShotCron(cronExpression) ? 1 : 0;
```

`isOneShotCron`（同文件 `94-101`）把「秒分时日月都是固定数字、周为通配」视为只跑一次。创建任务在没传 `once` 时会按这个规则赋值。更新任务的注释也说要重判，条件却多了 `task.once == null`。

**触发条件**：已有任务（`once` 列为 0 或 1，不是 NULL）只改 `cron_expression`、请求里不带 `once`：

- 每天循环改成固定月日（例如 `0 0 9 * * *` → `0 0 8 15 8 ?`）；
- 或一次性改成每天。

**错误结果**：条件进不去，`once` 保持旧值。

- 循环改成一次性后 `once` 仍为 0：跑完不会 `finished`，明年同一天还会再触发（`executeTask` 里 `latest.once === 1` 才完结，见 `392-397`）。
- 一次性改成每天后 `once` 仍为 1：第一次跑完就 `finished=1` 且 `nextFireTime=null`，后面的每天都不会再跑。

**正确预期**：与注释和 `createTask` 一致。未显式传 `once` 时按新 cron 重判，即 `if (once == null)`。显式传了 `once` 时，上面第 198 行已经写过，不应再被这条挡住或覆盖。

**确信依据**：注释与条件矛盾；`once` 在创建时就被写成 0/1，读出来的存量行不会是 `null`。

---

## B06 [P2] 后台子代理完成通知崩溃后续写第二条

**位置**：正常完成 `backend-ts/src/harness/delegate/background-subagent-manager.ts:701-702`；恢复投递 `subagent-result-delivery.service.ts:116-152`。对照同文件 DELEGATE 分支 `63-67` 的 `findMessagePair`。

正常结束时先插父会话里的「后台子代理…已完成/失败」ASSISTANT（`persistCompletionNotice`），再单独把 `delivery_status` 更新为 `DELIVERED`。两步不在同一个事务里。

恢复协调器在子执行结束后调用 `deliver()`。`deliver` 看到 `delivery_status` 不是 `DELIVERED`/`SUPPRESSED` 就继续。BACKGROUND / FOLLOWUP 分支不查父会话里是否已有 `backgroundSubagentCompletion` 元数据，直接再 `insert` 一条同样文案的 ASSISTANT，然后才把状态写成 `DELIVERED`。

**触发条件**：`persistCompletionNotice` 已提交，进程在 `updateById({ deliveryStatus: 'DELIVERED' })` 之前退出（部署重启、OOM）。重启后该行仍是 `PENDING`，`recoverGroup` 再走 `deliver`。

**错误结果**：父会话里出现两条几乎相同的完成通知，文件变更也会按通知各复制一份（`copyFileChanges` 两边都会跑）。

**正确预期**：与 DELEGATE 分支一样，插入前先按 `executionId` / `backgroundSubagentCompletion` 查找已有通知，有则只补 `delivery_status`，不再插消息。

**确信依据**：DELEGATE 有 `findMessagePair` 幂等；BACKGROUND 的 `deliverBackground` 无条件 `insert`。两步写入之间没有事务把「消息 + 状态」绑在一起。

---

## B07 [P2] ECP 登录 state 的过期时间与领取时钟不是同一套

**位置**：写入 `backend-ts/src/auth/ecp-auth.service.ts:48-54`、`189-193`；领取比较 `ecp-auth.service.ts:84` + `ecp-oauth.repository.ts:77-81`；「现在」`auth.service.ts:90-94` 固定 `Asia/Shanghai`。

```ts
// ecp-auth.service.ts:189-193
function plusSeconds(seconds: number): string {
  const date = new Date(Date.now() + seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-...${pad(date.getHours())}:...`; // 进程本地墙钟
}
```

`claimPending` 的 SQL 是 `expires_at > ?`，传入的 `now` 是 `formatNow()`（上海墙钟字符串）。两边都是 `YYYY-MM-DD HH:mm:ss`，按字符串比较。

**触发条件**：进程时区不是 `Asia/Shanghai`。常见是容器默认 `TZ=UTC`。用户发起 ECP 飞书登录后立刻回调。

**错误结果**：`expires_at` 是 UTC 墙钟（大约比上海时间早 8 小时），`now` 是上海墙钟。300 秒有效期盖不住这 8 小时，`expires_at > now` 为假，`claimPending` 返回 0。接口报「ECP 登录 state 已使用或已过期」。此时 `isExpired` 用 `new Date(expiresAt)` 按本地时区解析，往往还认为没过期，所以失败点在 claim，不在前面的过期检查。时区为上海时两条时钟重合，问题不出现。

**正确预期**：写入和比较用同一套时钟。同文件回调路径已经用 `formatNow()` / 上海时间，`plusSeconds` 应改成同一格式（或两边都用绝对时刻）。

**确信依据**：`formatNow` 显式指定 `Asia/Shanghai`；`plusSeconds` 用 `Date#getHours()`，随 `process` 时区变。SQL 是字符串比较，不是 `TIMESTAMP` 时区转换。

---

## 复查后未列入

| 候选 | 为何不收 |
|---|---|
| 通知调度 `resolveProperties` 失败断链、ECP `RENEWING` 卡死、30 分钟丢后台任务、飞书 FAILED 丢文件、队列重复 USER、空闲取消写成 CANCELLED | 0.0.177 已修，当前代码能对上修复 |
| 用量分析重复标签、提问面板只显示最后一组 | 0.0.178 已改面板取 `items[0]`；剩余问题是 B04 的 clear，不重复记面板 |
| `scanAndExecute` 的 catch 完全不写失败状态 | 不成立。catch 会写 `FAILED` 并重算 `nextFireTime`（`scheduled-task.service.ts:540-547`）。真正的问题是重算到了下一档而不是留在本次 due，见 B03 |
| `SubAgentResultCollector.onThinkingStart` 清空已输出正文 | 推理在正文之前到达时，清空发生在正文写入之前，结果仍完整。只有「先正文、后再次推理」才会丢前缀，依赖模型分片顺序，本次不单列 |
| 微信 `fetchBytes` 不看 HTTP 状态码 | `wechat-tools.ts:134-144` 确实会把 4xx/5xx 正文当文件上传，同仓库 `web-search-tool.ts` 与 `downloadAndEncode` 会拒绝非 2xx。触发面限于模型传入的 URL，未算进本次核心七条 |
| 通知 `deliver` 外层 catch 不改 `SENDING` | 发送前抛错会卡在 `SENDING`，约 5 分钟后 `recoverInterrupted` 打回 `PENDING` 再发，属于延迟而不是丢通知。只有「webhook 已成功、随后回写抛错」才会重发，窗口窄，本次不单列 |
