# 核心功能逻辑 BUG 审查（2026-09-21 17:26）

- **基线**：`main` @ `e54e0389`（feat(backend): enhance Feishu progress card handling during recovery）
- **范围**：`backend-ts/src/` 全域（harness 引擎、session/WS、feishu 入站、schedule、notification、auth/ECP、shell/terminal、file/git、mcp）+ `desktop/src/` 前端共用 UI
- **判定口径**：只收录「在可描述的输入 / 时序 / 边界条件下，代码行为与同文件注释或同路径既有实现的明确意图不符，且会产生用户可感知的错误结果」的问题。纯风格、性能、命名、类型写法不计。
- **方法**：候选由分区精读产出，逐条回源码复核；复核不成立的 5 条列在文末「复查后未列入」，避免后续重复排查。
- **修复状态（2026-09-21 18:05 补记）**：B01–B12 已全部修复并补回归单测，随 `0.0.177` 发布（见根 `CHANGELOG.md`）。下文各条的「现状 / 期望」保留审查时的原样，便于回溯。

## 问题总览

| 编号 | 级别 | 模块 | 一句话 |
|---|---|---|---|
| B01 | P1 | harness/core | 后台任务跑过 30 分钟就被移出登记表，结果永久丢失，`await_async` 反馈「任务不存在」 |
| B02 | P1 | notification | 调度参数读取失败后不再重排定时器，任务通知投递整进程停摆 |
| B03 | P1 | auth/ECP | 续期途中重启，`renew_status` 永久卡在 `RENEWING`，该用户自动续期再也不执行 |
| B04 | P1 | feishu | 忙碌期暂存的文件在本轮任务 FAILED 时永不落库，后续提问看不到文件 |
| B05 | P1 | session/WS | 队列自动消费提交被拒时回补队列但不删已落库的 USER 消息，产生重复消息 |
| B06 | P2 | session/WS | 出队与回补补偿之间还有两段无补偿窗口，异常即丢消息或留孤儿 USER |
| B07 | P2 | session/WS | 无执行在跑时的 `cancel` 会把 `IDLE` 会话落成 `CANCELLED` |
| B08 | P2 | desktop | 审批先出队再发送，WS 发送失败后审批项消失、服务端仍在等 |
| B09 | P2 | desktop | 本轮耗时回填写到「当前活跃会话」的最后一条消息，切会话后串台 |
| B10 | P3 | harness/shell | `write_stdin` 无 pending 分支不收尾会话，返回文案说「会话已关闭」但实际没关 |
| B11 | P3 | harness/terminal | 单帧大于缓冲上限时环形缓冲被清空，重连回放整段丢失且连截断提示都没有 |
| B12 | P3 | harness/mcp | MCP 工具参数非法 JSON 静默变成 `{}` 并照常发起调用 |

---

## B01 [P1] 后台任务跑过 30 分钟即被放弃，结果永久丢失

**位置**：`backend-ts/src/harness/core/background-task-manager.ts:45-71`（另见 `:36-40`、`:15`、`:34`、`:67`）

```ts
// background-task-manager.ts:65-70
} else if (now - entry.submitTimeMs > ABANDONED_THRESHOLD_MS) {
  if (sessionId !== entry.sessionId) continue;
  entry.cancelled = true;
  this.tasks.delete(taskId);
  harnessLog('warn', `Cancelled abandoned background task: ${taskId} session=${entry.sessionId}`);
}
```

**触发条件**：`shell` 工具以 `async: true` 提交一条耗时超过 `ABANDONED_THRESHOLD_MS`（30 分钟）的命令——正是工具描述里点名的场景（`shell-session-tool.ts:68`：「await_async：继续等待会话中未结束的命令（长时构建、后台任务）」）。`AgentLoop` 每轮开头调用 `consumeCompletedResults`，在跨过 30 分钟的那一轮命中该分支。

**错误结果**：

1. `entry` 从 `tasks` 移除，但 `submit` 里挂的 `then`（`:36-40`）只写回已被摘除的 `entry` 对象，任务真的跑完时结果无人消费——`<后台任务结果>` 自动注入再也不会出现。
2. 模型继续 `await_async` + `task_id` 时走 `awaitResult` → `not_found`，工具返回「后台任务不存在或已被消费」（`shell-session-tool.ts:326`），把「还在跑」误报成「已被消费」。
3. 日志写的是 `Cancelled abandoned background task`，但 `entry.cancelled` 这个字段全仓库无人读取（只在 `:15` 声明、`:34` 初始化、`:67` 赋值），底层命令并没有被取消，仍在服务器上继续跑。

**正确预期**：未完成的任务要么等 Promise settle 后再回收，要么在回收时真正终止底层执行并给模型一个明确的失败结果；不应在任务仍可能成功时静默丢弃，更不应把状态反馈成「不存在」。

**确信依据**：`cancelled` 是死字段，证明「取消」意图未落地；`consumeCompletedResults` 只遍历 `this.tasks.keys()`，没有第二索引能找回被删条目。

**单测覆盖**：`harness/core/` 下无 `background-task-manager.spec.ts`，30 分钟放弃 + 迟到完成的组合完全无测。

**建议**：`done === false` 时不删条目，改为标记并保留（或落 `error` 结果后由所属会话消费一次）；若确实要回收，需同时 kill 对应 shell 会话并写入可消费的失败结果。

---

## B02 [P1] 通知调度参数读取失败后调度链断裂，任务通知整进程停摆

**位置**：`backend-ts/src/notification/task/delivery.scheduler.ts:139-149`

```ts
private scheduleNext(): void {
  void this.resolveProperties()
    .then((p) => {
      if (this.stopped) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        void this.dispatchDueDeliveries().finally(() => this.scheduleNext());
      }, Math.max(1000, p.workerDelayMs));
    })
    .catch((e) => console.error('任务通知调度参数读取失败，1 分钟后重试', e));
}
```

**触发条件**：`propertiesSource` 是动态 getter（读后台配置，保存后即时生效）。DB 抖动、连接池耗尽、配置行异常等任一次让 `resolveProperties()` reject。

**错误结果**：`catch` 只打日志，**没有任何重排**——`setTimeout` 链在这里彻底断开。之后 `PENDING` / `WAITING_WS` 的投递行不再被 `listDue` 扫描，用户配置的任务完成 webhook 通知全部不再发送，直到手动重启后端。而日志正好写着「1 分钟后重试」，运维看日志会以为已自愈。

**正确预期**：与日志文案及成功路径（靠 `dispatchDueDeliveries().finally(() => this.scheduleNext())` 续链）一致，失败分支应 `setTimeout(() => this.scheduleNext(), 60_000)` 续上。

**确信依据**：`dispatchDueDeliveries` 自身有 try/catch 不会断链，唯一断链点就是这里；`stop()` 之外没有其它路径清空 `this.timer`，断链后无人重建。

**单测覆盖**：`delivery.scheduler.spec.ts` 覆盖 `start`、空队列 dispatch、动态 batchSize，没有「resolveProperties reject 后仍应继续轮询」的断言。

**建议**：`catch` 内改为 `if (!this.stopped) this.timer = setTimeout(() => this.scheduleNext(), 60_000)`，并补一条 reject 后仍续跑的单测。

---

## B03 [P1] ECP 续期途中重启，会话永久卡在 RENEWING，自动续期不再执行

**位置**：`backend-ts/src/auth/ecp-renew.scheduler.ts:57-72` + `backend-ts/src/auth/ecp-session.repository.ts:89-104`、`:120-125`

```ts
// ecp-renew.scheduler.ts:57-67
private async renewOne(config: EcpConfig, row: { id?: number; sessionTokenEnc: string }): Promise<void> {
  if (row.id == null) return;
  if (!await this.sessions.markRenewing(row.id)) return;   // ← 这里之后进程挂掉，状态就永远是 RENEWING
  ...
  const renewed = await this.client.renewSession(config, oldToken);
  await this.sessions.saveRenewed(row.id, this.encrypt(renewed.sessionToken), renewed.expiresAt);
```

```sql
-- ecp-session.repository.ts:89-95，只捞 ACTIVE
WHERE renew_status = 'ACTIVE' AND expires_at <= ?
```

**触发条件**：`markRenewing` 成功之后、`saveRenewed` / `markFailed` 之前进程终止——按 `CLAUDE.md` 的运维流程，`restart-backend.sh` 部署重启是常规操作，而续期窗口是到期前 30 分钟、每 60 秒一跳，用户量和发版频率一叠加就会命中。

**错误结果**：该行 `renew_status` 停在 `RENEWING`。`listDueForRenew` 只捞 `ACTIVE`，永远不会再续期；`clearFailed`（`:120-125`）只处理 `FAILED`，也救不回来。而 `isUsableEcpSession`（`:27-37`）只排除 `FAILED` 和已过期，所以在 `expires_at` 到点前系统仍认为这张票可用、不会提示重新绑定；到点后才突然变成「无有效 ECP 票」，CLOUD 工具与飞书入站门控一起失效，只能靠用户自己重新走一次 ECP 登录（`upsert` 会把状态写回 `ACTIVE`）。

**正确预期**：中间态需要有超时恢复。同仓库已有现成范式——`DeliverySchedulerDbStore.recoverInterrupted`（`notification/task/delivery.scheduler.ts:27-31`）就是把卡在 `SENDING` 超过 5 分钟的行复位成 `PENDING`，`ECP` 这条链缺了等价动作。

**确信依据**：全仓 grep `renewStatus` / `renew_status`，除 `upsert`、`saveRenewed`（都要求流程正常走完）外，没有任何路径把 `RENEWING` 改回 `ACTIVE`。

**单测覆盖**：`ecp-renew.scheduler.spec.ts` 只有成功续期与抛错后 `markFailed` 两条，没有「陈旧 RENEWING 应被复位」。

**建议**：给 `user_ecp_session` 加 `renew_status='RENEWING' AND updated_at < cutoff → ACTIVE` 的周期复位（可挂在 `tick()` 开头，参照 `RECOVERY_INTERVAL_MS` 的节流写法）。

---

## B04 [P1] 飞书忙碌期暂存的文件在本轮任务 FAILED 时永不落库

**位置**：`backend-ts/src/feishu/agent-inbound-handler.ts:469-477`、`:507-520`、`:720-727`

```ts
// agent-inbound-handler.ts:469-477
// 本消息执行结束（或入队后队列需推进）时，先把忙碌期间收到的文件落库，再接力消费队列；
// 上一任务 FAILED 时不再自动消费下一条（延续失败上下文执行会产生不可信结果）。
if (executed && phase !== 'FAILED') {
  void this.flushAttachmentsAndDrain(sessionId, ...)
}
```

**触发条件**：会话正在跑 Agent 时用户先发一个文件（`doIngestFile` 走 `:720-722` 的 `stashPendingAttachment`），紧接着发文字触发新任务，而这轮任务以 `FAILED` 结束。

**错误结果**：`persistPendingAttachments` 只在 `flushAttachmentsAndDrain → drainNext`（`:513-520`）里被调用，是全仓唯一的落库入口。`phase === 'FAILED'` 一起把它跳过后，文件路径只留在 `pendingAttachments` 这个内存 Map 里：用户随后追问「看下我发的那个文件」时会话历史里根本没有 `@{路径}@`，Agent 只能回答找不到文件；进程重启则彻底丢失。

**正确预期**：`phase !== 'FAILED'` 这道闸门的本意（见同处注释）只是「失败后不自动消费下一条队列消息」，落附件不该被它牵连——文件已经下载到工作区，写入历史是幂等的，与上一轮成败无关。

**确信依据**：注释明确区分了两件事（落库 / 接力消费），但代码把它们绑在同一个条件上；`drainNext`（`:533-537`）内部已经再判过一次 FAILED，所以「失败不接力」的目标即使拆开也仍然成立。

**单测覆盖**：`agent-inbound-handler.spec.ts:766` 覆盖「忙碌暂存 → 本轮成功后落库且不二次执行」，`:848` 覆盖「FAILED 后不接力消费队列」，但两者交叉的「忙碌暂存 + 本轮 FAILED」没有用例。

**建议**：把 `persistPendingAttachments` 从 `flushAttachmentsAndDrain` 里拆出来无条件执行（仍在 `withLock` 内），只让 `drainNext` 受 FAILED 约束。

---

## B05 [P1] 队列自动消费提交被拒时回补队列但不删已落库 USER，产生重复消息

**位置**：`backend-ts/src/session/ws/streaming-ws-handler.ts:1289-1307`，对照同文件 `:318-321` 与 `:343-364`

```ts
// streaming-ws-handler.ts:1300-1306
} catch (submitErr) {
  // 提交被拒时释放占位并回补队列，避免消息已出队却永不执行
  this.executionClaims.delete(sessionId);
  this.autoConsumingSessionIds.delete(sessionId);
  this.queueScheduledTaskIds.delete(sessionId);
  await this.deps.messageQueueService.enqueueHead(sessionId, userId, content, head.images ?? null, head.scheduledTaskId ?? null);
  throw submitErr;
}
```

**触发条件**：上一轮执行结束触发 `autoConsumeQueue`，队头已 `dequeue` 且 `saveMessage` 成功（例如 id=100），随后 `this.deps.agentExecutor(...)` **同步抛出** `AgentExecutorRejectedError`——`createAgentExecutor.submit` 在 `active >= max` 且队列满时就是同步 `throw`（`harness/core/agent-executor.ts:54`）。高并发或线程池调小时可复现。

**错误结果**：队列行被 `enqueueHead` 补回，但 id=100 的 USER 消息仍留在会话里。下次消费同一队列项会再写一条同内容 USER，聊天记录出现重复用户消息，模型上下文也多一轮重复提问。

**正确预期**：同文件 `:318-321` 的注释把这条不变量写得很明白——「否则下次消费会再写一条同内容 USER 消息（重复落库）」，`requeueIfClaimed`（`:343-364`）正是按此在回补前 `deleteMessageById(sessionId, autoSavedMessageId)`。`autoConsumeQueue` 的提交失败分支漏掉了这一步。

**确信依据**：两条回补路径同处一文件、同一不变量，一条删孤儿一条不删；`agentExecutor` 的同步 throw 路径在 `streaming-ws-handler.spec.ts:193`（`releases the execution claim when the agent executor rejects the task`）已被证明是真实可达路径，只是那条用例走的是手动 `send_message`。

**单测覆盖**：无「autoConsume 已落库后 submit 被拒」的用例。

**建议**：该分支补 `deleteMessageById(sessionId, savedMessage.id)`，或直接复用 `requeueIfClaimed` 的收尾逻辑，避免两处各写一遍。

---

## B06 [P2] 出队之后仍有两段无补偿窗口，异常即丢消息或留孤儿

**位置**：`backend-ts/src/session/ws/streaming-ws-handler.ts:1253-1262`、`:1283-1287`、`:1308-1314`

```ts
// :1253-1262
const head = await this.deps.messageQueueService.dequeue(sessionId);   // 不可逆：队列行已标 DELETED
if (!head) { this.executionClaims.delete(sessionId); return; }
if (head.scheduledTaskId != null) this.queueScheduledTaskIds.set(sessionId, head.scheduledTaskId);
await this.sendQueueUpdated(sessionId, userId);                         // ← 抛错则落到外层 catch，不回补
...
// :1283-1287（saveMessage 已成功，但不在 submit 的补偿 try 内）
this.deps.titleService.scheduleForFirstUserMessage(...);
this.deps.registry.send(userId, wsEvent('queue_message_consumed', ...));
```

**触发条件**：`sendQueueUpdated` 里的 `listPending` 查询失败（DB 抖动），或 `:1283-1287` 这段抛错。

**错误结果**：外层 catch（`:1308-1314`）只清内存标志，既不 `enqueueHead` 也不删已落库消息。第一种窗口里消息既不在队列也没落库，**静默消失**；第二种窗口里 DB 多一条没有对应执行的 USER 消息，而队列里已经没有它了。

**正确预期**：`:1273` 的注释已经把规则定死了——「队列行已出队（dequeue 已删除），saveMessage 失败必须回补队首，否则消息静默丢失」。同一规则应覆盖 dequeue 之后的**所有**早退路径，而不只是 `saveMessage` 和 `submit` 两处。

**确信依据**：`saveMessage` 失败（`:1272-1281`）与 submit 失败（`:1300-1306`）各有补偿，夹在中间和前面的两段没有，属明显的补偿覆盖不全而非设计取舍。

**建议**：把 dequeue 之后的整段包进一个统一的补偿 try（回补队首 + 删孤儿消息 + `sendQueueUpdated`），或把出队做成事务性领取（`claim` 而非 `delete`，失败即释放）。

---

## B07 [P2] 无执行在跑时的 cancel 会把 IDLE 会话落成 CANCELLED

**位置**：`backend-ts/src/session/ws/streaming-ws-handler.ts:1072-1081`、`:1485-1487`、`:1526-1531`；`backend-ts/src/session/task-terminal.service.ts:12`、`:31-40`

```ts
// streaming-ws-handler.ts:1072-1081
if (!this.cancelFlags.has(sessionId)) {
  this.pendingCancels.set(sessionId, Date.now());
  this.deps.registry.send(userId, wsEvent('cancelled', sessionId, { pending: true, ... }));
  await this.finishCancelledSession(sessionId, userId, ...);   // 不校验会话是否真的在跑
  return;
}
```

```ts
// :1485-1487，IDLE 不在终态集合内，于是 finishCancelledSession 会继续往下写
private isTerminalPhase(phase: string | null | undefined): boolean {
  return phase === 'COMPLETED' || phase === 'FAILED' || phase === 'CANCELLED';
}
```

**触发条件**：会话处于 `IDLE`（新建会话、或编辑重发回滚后），此时没有执行、`cancelFlags` 为空，客户端仍发出 `cancel`（重复点击、快捷键、停止请求与终态回写竞态）。

**错误结果**：`finishCancelledSession` → `TaskTerminalService.finishExecution(..., 'CANCELLED')`，而 `TaskTerminalService` 的终态集合只有 `COMPLETED/FAILED/CANCELLED`（`:12`），`IDLE → CANCELLED` 被放行。一个从未运行过的会话被写成「已取消」，任务列表与分组状态与事实不符，还会顺带 `cleanupIncompleteTail`。

**正确预期**：该分支的注释说明其针对的是「执行尚未提交」的窗口（send 的模型校验 / autoConsume 的 500ms 延迟）。这些窗口下 `executionClaims` 会被持有，因此收尾前应先确认会话确实处于活跃或被占用状态（`isSessionActive(phase) || executionClaims.has(sessionId)`），空闲会话应只登记 `pendingCancels` 而不落终态。

**确信依据**：`isActivePhase`（`session/session-vo.ts:416-418`）= `RUNNING/RESUMING/WAITING_APPROVAL/CANCELLING`，两个判定集合都不含 `IDLE`，所以 `IDLE` 既不被当活跃也不被当终态，直接穿过。

**单测覆盖**：`streaming-ws-handler.spec.ts` 的 cancel 用例（`:629` 起）都建立在 `RUNNING` 上，没有 IDLE 会话 cancel 的断言。

---

## B08 [P2] 审批先出队再发送，WS 失败后审批项消失而服务端仍在等

**位置**：`desktop/src/composables/useChat.ts:66-76`

```ts
async function confirmApproval(requestId: string, approved: boolean) {
  const item = pendingApprovals.value.find(a => a.requestId === requestId)
  if (item?.sessionId) sessionStore.decrementPendingApproval(item.sessionId)
  pendingApprovals.value = pendingApprovals.value.filter(a => a.requestId !== requestId)
  ...
  if (item?.sessionId) {
    const { sendToolApproval } = useStreamWS()
    await sendToolApproval(item.sessionId, requestId, approved)   // 返回值未检查
  }
}
```

**触发条件**：弹出工具审批后网络断开或 WS 重连超时，用户点「批准」/「拒绝」，`sendToolApproval` 走 `sendReliable` 返回 `false`（`useStreamWS.ts:360-385`，含 15 秒连接超时）。

**错误结果**：UI 与侧栏待审批计数已按成功处理，审批项从队列中消失；服务端仍停在 `WAITING_APPROVAL` 等回包。用户看不到任何可重试的入口，任务表现为卡死。

**正确预期**：只有发送成功才移除并递减计数；失败应保留审批项并提示重试（`useChat` 其它路径如 `prepareAndSendMessage` 失败时就会回滚乐观状态）。

**建议**：拿 `sendToolApproval` 的返回值，`false` 时把 `item` 放回 `pendingApprovals` 并恢复计数，配 `ElMessage.error` 提示。

---

## B09 [P2] 本轮耗时回填写到「当前活跃会话」的最后一条消息

**位置**：`desktop/src/composables/useChat.ts:526-537`

```ts
if (!pendingCallbacks.has(sid)) {
  new Promise<void>((resolve, reject) => { pendingCallbacks.set(sid, { resolve, reject }) })
    .then(() => {
      if (startedAt.value) {
        const lastMsg = messages.value[messages.value.length - 1]   // ← activeMessages，与 sid 脱钩
        if (lastMsg && lastMsg.role === 'assistant') {
          lastMsg.durationMs = Date.now() - new Date(startedAt.value).getTime()
        }
        startedAt.value = null
      }
    })
}
```

**触发条件**：在会话 A 发送消息并收到保存确认（函数已返回，Agent 后台继续跑）→ 切到会话 B → A 执行结束触发回调。

**错误结果**：耗时被写到**会话 B** 最后一条 assistant 消息上，B 显示一个与自己无关的耗时，A 的真实耗时丢失；`startedAt` 也被清空。

**正确预期**：同函数上方 12 行的注释已经明确了规则——「必须用本次发送的 sid，而非 activeSession（等待期间用户可能已切走会话）」（`:517-518`）。回调里应按 `sid` 取消息列表，或先校验 `String(sessionId.value) === String(sid)`。

**确信依据**：`messages` 绑定的是 `sessionStore.activeMessages`（`useChat.ts:162-163`），随活跃会话切换而变；同一函数内前一个分支已按 sid 做了守卫，后一个分支漏了。

---

## B10 [P3] `write_stdin` 无 pending 分支不收尾会话，返回文案与实际不一致

**位置**：`backend-ts/src/harness/tool/impl/shell-session-tool.ts:308-312`，对照 `:217`、`:300`、`:355`

```ts
const marker = this.newMarker();
this.writeCommand(session, input, marker, true, null);
const result = await this.outputManager.readUntilMarker(session, marker, yieldTimeMs, waitFor);
return toJson(this.formatResult(session, result, await this.resolveCurrentWorkdir(session, result)));
// ↑ 缺 this.settleSession(session, result, true)
```

**触发条件**：会话没有 pending 命令时用 `write_stdin` 写入让 bash 退出的内容（`exit`、`exec` 等）。

**错误结果**：`formatResult` 在 `result.shellExited` 时返回「shell 进程已退出，会话已关闭」（`:256-257`），但 `settleSession` 未被调用，会话并没有从 `sessionManager` 摘除。死会话最多要等 `cleanupExpiredSessions`（默认 60 秒一轮）才回收，期间仍计入 `maxSessionsPerConversation`（30）的配额，`getOrCreate` 的上限检查按含死会话的 `convSessions.size` 判断（`shell-session-manager.ts:536-538`），极端情况下会报「已达会话上限」。

**正确预期**：与 `exec`（`:217`）、`write_stdin` 的 pending 分支（`:300`）、`await_async`（`:355`）一致，返回前调用 `settleSession(session, result, true)`——`settleSession` 注释本就写着「bash 已退出时 keep_session 也无法复用，必须回收」。

---

## B11 [P3] 单帧大于缓冲上限时环形缓冲被清空，重连回放整段丢失

**位置**：`backend-ts/src/harness/terminal/remote-terminal.ts:3-27`

```ts
append(data: string): void {
  if (data === '') return;
  this.chunks.push(data);
  this.bytes += Buffer.byteLength(data, 'utf8');
  while (this.bytes > this.maxBytes && this.chunks.length > 0) {
    const dropped = this.chunks.shift()!;   // 单个 chunk 就超限时，把刚写进来的这一段也丢掉
    this.bytes -= Buffer.byteLength(dropped, 'utf8');
    this.truncated = true;
  }
}
```

**触发条件**：一次 `onData` 的数据量超过 `maxBytes`。默认 `terminal.outputBufferBytes` 为 262144（`settings/settings.service.ts:416`），管理后台可下调，调小后很容易被一条 `cat` 大文件的输出单帧突破。

**错误结果**：循环把唯一的 chunk 也 shift 掉，`chunks` 变空。此时 `read()` 因 `body === ''` 直接返回空串（`:23-27`），连「历史输出过长，已截断前面部分」的提示都不会带上——用户断线重连后终端一片空白，看不出发生过截断。

**正确预期**：类注释说的是「超出上限时从头部丢弃，attach 时整体回放」，语义上应保留最近输出。超大单帧应按字节做尾部截断（保留末尾 `maxBytes`）而不是整段丢弃；即使缓冲为空，只要 `truncated` 为真也该回放提示。

**单测覆盖**：`terminal-manager.spec.ts:109-120` 只用多段小数据（`new OutputRingBuffer(10)` + 三段 5/5/3 字节）验证头部淘汰，无单帧超限用例。

---

## B12 [P3] MCP 工具参数非法 JSON 静默变成 `{}` 并照常调用

**位置**：`backend-ts/src/harness/mcp/mcp-client-manager.ts:191-199`

```ts
function parseArguments(argumentsJson: string | null | undefined): Record<string, unknown> {
  if (!argumentsJson || argumentsJson.trim() === '') return {};
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
```

**触发条件**：模型吐出的 tool_call 参数被截断或格式非法（非空但 parse 失败）。

**错误结果**：不报错，改用**空对象**调用 `client.callTool`。缺参数的 MCP 工具要么报一个与真实原因无关的业务错，要么按默认值执行了非预期动作，模型拿到的是误导性结果而不是「参数不合法，请重试」。

**正确预期**：与内置工具一致——`shell-session-tool` 的 `parseWaitFor` 在参数非法时返回明确的 `errorJson` 而不是兜底默认值。参数 parse 失败应直接返回错误、不发起调用。

**单测覆盖**：`mcp-client-manager.spec.ts:69` 用 `'not-json'` 仍期望调用成功（只验证结果格式化），实际把当前的兜底行为固化了。

---

## 复查后未列入（避免后续重复排查）

| 候选 | 复核结论 |
|---|---|
| Anthropic 纯 thinking + `stop_reason=max_tokens` 不重试 | **不成立**。`hasContentOutput` 只在 `text_delta`（`:320`）与 `tool_use` 的 `content_block_start`（`:338`）置位，`thinking_delta` 不置位，因此 `:409` 的 `max_tokens && !hasContentOutput` 恰好会抛 `StreamThinkingTruncatedException` 并走重试——这就是期望行为。 |
| `ShellSession.writeStdin` 不处理 `write()` 背压会截断长命令 | **不成立**。Node 流在超过 highWaterMark 时会内部缓冲，`write()` 返回 `false` 只代表「该等 drain」，不会丢数据。 |
| `useStreamWS.subscribe` 失败后被永久标记已订阅 | **影响可自愈**。`subscribedSessionIds.add` 确实在 `sendReliable` 之前且失败不回滚，但 `onopen`（`useStreamWS.ts:207-214`）会把集合内所有会话整体重订阅，下一次成功连接即恢复，不构成持久错误。 |
| `glob_search` 截断时 `total_matched` 只等于返回条数 | **归入语义/文档问题**。`file-tools.spec.ts:323` 明确断言了 `truncated: true` 时 `total_matched === 1`，属既定契约，改动需同步工具描述，不按 BUG 记。 |
| `listBySession` 用 `ORDER BY created_at ASC, id ASC` 与「按 id 单调序」不一致 | **不作为 BUG**。次级排序键已是 `id`，只有在 `created_at` 真的逆序（跨节点时钟回拨）时才会与按 id 定位的编辑逻辑分叉，缺少可稳定复现的触发路径。 |

## 修复优先级建议

1. **先修 B02、B03**：两者都是「一次偶发异常 → 功能整体停摆且无自愈」，改动小（补一次重排 / 补一条复位 SQL），收益最大。
2. **再修 B04、B05、B06**：都在消息落库与队列补偿链上，会造成用户可见的丢文件 / 重复消息 / 丢消息，建议一并梳理成统一的补偿路径。
3. **B01** 需要配套设计（回收时是否真 kill 底层会话），改动面稍大，建议单独排期，先把「结果不再静默丢弃」做掉。
4. **B07~B09** 为状态一致性与前端体验问题，可随手带上；**B10~B12** 属稳健性收尾，低优先。
