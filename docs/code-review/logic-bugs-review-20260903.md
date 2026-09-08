# 核心功能逻辑 BUG 审查报告（2026-09-03）

审查范围：backend-ts（harness 引擎、工具实现、session/WS 流、消息队列）、desktop 前端（useStreamWS / useChat / stores / useCenterTabs）、agent-cli WS 客户端、通知投递调度。方法：人工通读源码，逐条推演触发路径；已排除同仓库历史 review 文档（`docs/code-review/`）中已记录的旧问题后定稿。

严重度说明：高 = 功能错误 / 状态永久卡死；中 = 特定场景下功能异常或数据重复；低 = 降级路径或边缘输入下的行为偏差。

---

## BUG-1【高】取消请求在「claim 已持有、cancel flag 未注册」窗口内被静默丢弃，任务继续执行

- 位置：`backend-ts/src/session/ws/streaming-ws-handler.ts:906-922`（`handleCancel`）与 `:305-356`（`handleSendMessage`）

`handleCancel` 只在 `cancelFlags` 与 `executionClaims` **都不存在**时才登记 `pendingCancels`：

```ts
if (!this.cancelFlags.has(sessionId) && !this.executionClaims.has(sessionId)) {
  this.pendingCancels.add(sessionId);
  ...
  await this.finishCancelledSession(sessionId, userId, ...);
  return;
}
```

而 `handleSendMessage` 在 `executionClaims.add(sessionId)`（L309）之后、`agentLoop.registerCancelFlag(sessionId)`（L342）之前存在多个含 `await` 的窗口：LOCAL 模式 `isConnected` 检查（内部 `resolveUserId` 缓存未命中会查库）、以及普通消息的 `saveMessage` 落库。窗口期内用户点「停止」时：

1. `handleCancel` 走 else 分支：`abortRunningExecution`（此刻两个 cancel flag map 都还没有本会话条目，等于空转）+ `finishCancelledSession` 把 DB phase 置为 `CANCELLED`；
2. `pendingCancels` **没有**被登记；
3. `handleSendMessage` 的 await 恢复后继续执行，`pendingCancels.delete(sessionId)` 返回 false，照常 `submitExecution`；
4. `runExecution` 里 `updatePhase(sessionId, 'RUNNING')` 无条件把刚写入的 `CANCELLED` 覆盖回 `RUNNING`，Agent 完整跑完。

用户感知：点了停止、界面先显示已取消，随后收到 `session_status RUNNING` 又变回执行中，任务停不下来。代码注释里的 M-2 修复只覆盖了「claim 与 flag 都不存在」的窗口，漏掉了本窗口。

修复建议：`handleCancel` 把条件改为只要 `executionClaims.has(sessionId)` 也登记 `pendingCancels`（登记 `pendingCancels` 后仍可立即 `finishCancelledSession` 收敛 DB 状态）；或在 `handleSendMessage` 提交执行前复查一次 `pendingCancels` / DB phase。

---

## BUG-2【高】`handleEditAndResend` 中 `prepareMessage` 抛异常导致 `executionClaims` 永久泄漏，会话被锁死

- 位置：`backend-ts/src/session/ws/streaming-ws-handler.ts:527`（claim 添加）、`:546`（无保护的 await）

```ts
this.executionClaims.add(sessionId);              // L527
...
try {
  await this.deps.sessionService.editMessageAndTruncate(...);   // L539 有 catch，会释放 claim
} catch (e) { this.executionClaims.delete(sessionId); ...; return; }
...
const resolvedEventId = await this.deps.harnessService.prepareMessage(sessionId, messageContent); // L546 无保护
this.deps.registry.subscribe(userId, sessionId);
const flag = this.deps.agentLoop.registerCancelFlag(sessionId);
...
this.submitExecution(...);
```

L546 起的 `prepareMessage`（以及之后的 `registerCancelFlag` 等）不在任何 try/catch 内。`prepareMessage` 一旦抛错（如 DB 抖动），异常沿 `dispatch` 冒泡到 `handleTextMessage` 只被 `console.error` 吞掉，而 `executionClaims` 中该会话的占位永不释放——后续所有 `send_message` / `edit_and_resend` / `retry_execution` 都命中 `session_already_running`，该会话在进程重启前永久不可用（`runningTasks`/`runningExecutionIds` 均未登记，无任何 finally 兜底）。

对比同文件 `handleSendMessage` 的 M-4 修复（`saveMessage` 有 catch 并释放 claim）与 `handleRetryExecution` 的整体 try/catch，本路径是遗漏点。

修复建议：从 `executionClaims.add` 之后到 `submitExecution` 之前包一层 try/catch，失败路径统一 `executionClaims.delete` 并回发 error 事件。

---

## BUG-3【中】队列消息自动消费在校验失败时回补队首，但已落库的 USER 消息不回滚——重复消费产生重复消息

- 位置：`backend-ts/src/session/ws/streaming-ws-handler.ts:1077-1106`（`autoConsumeQueue`）、`:292-304`（图片校验）、`:269-280`（`requeueIfClaimed`）

`autoConsumeQueue` 的顺序是：出队 → **先 `saveMessage` 落库** → 延迟 500ms 后调 `handleSendMessage(claimAlreadyHeld=true)`。而 `handleEnqueueMessage` 入队时不做任何图片校验。当队列消息在下一次消费时未通过 `handleSendMessage` 的校验（模型已切换为不支持视觉、或图片超过 10 张）：

```ts
if (!model || model.supportsVision !== 1) {
  await requeueIfClaimed();          // 只把内容插回队首
  this.deps.registry.send(userId, wsEvent('error', ...));
  return;                            // 已落库的 USER 消息成为孤儿
}
```

结果：本次已写入会话历史的 USER 消息（含图片 contentParts）不会被删除，消息又回到队首；下一次执行结束后再次被消费，`saveMessage` 再写一条同内容消息。每轮「消费→校验失败→回队首」都会向会话历史新增一条重复的 USER 消息，且队列里这条消息永远无法被执行成功。（对比：`saveMessage` 本身失败的 M-3 路径只回补队列、尚未落库，无此问题。）

修复建议：`requeueIfClaimed` 针对 auto-consume 场景先 `deleteMessageById` 回滚本次落库的 USER 消息，或把图片校验前置到 `autoConsumeQueue` 出队之前 / `handleEnqueueMessage` 入队之时。

---

## BUG-4【中】`handleInsertMessage` 先终止运行中的执行、后校验 queueId——对无效队列消息也会误杀当前任务

- 位置：`backend-ts/src/session/ws/streaming-ws-handler.ts:943`（abort）与 `:948-952`（校验）

```ts
this.suppressAutoConsumeSend.add(sessionId);
this.abortRunningExecution(sessionId, userId);   // L943：无条件终止当前执行
try {
  this.deps.agentExecutor(async () => {
    await this.withLock(this.insertLocks, sessionId, async () => {
      const item = await this.deps.messageQueueService.getById(queueId);
      if (!item || item.sessionId !== sessionId) {   // L948：此时执行已被杀掉
        await this.sendQueueUpdated(sessionId, userId);
        return;
      }
```

点击「插队」时，`abortRunningExecution`（设置 cancel flag、关闭 shell 会话、失败所有待审批/待提问）在校验 queueId **之前**执行。若队列项在渲染到点击之间已被消费或删除（auto-consume 竞态的典型场景），代码自己的意图是「仅刷新队列」（L950 的行为），但当前正在运行的任务已经被取消，且 shell 会话被强行关闭。正确顺序应先校验队列项有效再 abort。

---

## BUG-5【低】`glob_search` JS 回退分支的 glob 正则未转义 `.`，模式过度匹配

- 位置：`backend-ts/src/harness/tool/impl/glob-search-tool.ts:130-161`（`globToRegExp`），对照组 `grep-search-tool.ts:213-216`

```ts
} else if ('+^${}()|[\]'.includes(ch)) {   // 转义集合缺少 '.'
  out += `\\${ch}`;
```

转义集合包含 `+^${}()|[\]` 与 `?`、`*` 的特殊处理，但漏掉了 `.`。当环境无 `rg`（`isRgAvailable()` 为 false 的回退分支）时，`*.ts` 被编译为 `^[^/]*.ts$`，其中 `.` 是任意单字符通配，`build`、`foots`、`aXts` 等不含点或非 `.ts` 后缀的文件名也会命中。同仓库 `grep-search-tool.ts` 的 `globToFileRe` 已正确把 `.` 列入转义集合（`[.+^${}()|[\]\\]`），两处应对齐。该问题同时影响 `glob_search` 工具的 `files` 输出准确性。

---

## BUG-6【低→中】`generateContextSummary` 把多模态消息的原始 JSON（含 base64 data URI）注入边路任务 system prompt

- 位置：`backend-ts/src/harness/core/harness-service.ts:539-559`

```ts
for (const msg of recent) {
  const content = msg.content;
  if (hasText(content)) {
    const truncated = content!.length > 300 ? content!.slice(0, 300) + '...' : content!;
    sb += `[${msg.role}]: ${truncated}\n`;
  }
}
```

带图消息落库时 `content` 是 `[{"type":"text",...},{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}]` 的 JSON 字符串。这里直接按原始字符串截断前 300 字符，边路任务的 system prompt 会得到一段被拦腰截断的 JSON/base64 乱码，既浪费上下文也可能诱导模型误读主任务内容。应先走 `extractVisibleText()`（session.service.ts:626 已有现成实现）提取纯文本。

---

## BUG-7【低】`useCenterTabs` 模块级 watch 捕获的是首个实例的 computed，组件卸载重建后已读同步失效（中等置信度）

- 位置：`desktop/src/composables/useCenterTabs.ts:68-88`（`ensureSideTaskReadWatch`）、`:138`（调用点）

`ensureSideTaskReadWatch` 用模块级标志保证 watch 只注册一次，并刻意放入 detached `effectScope` 解决「组件卸载后 watch 失效」的问题。但 watch 的数据源 `activeTab` 是**第一个**调用 `useCenterTabs()` 的组件实例 setup 中创建的 computed。Vue 中 setup 内创建的 computed 关联到该组件的 effect scope，组件卸载时 scope.stop() 会停掉该 computed 的副作用，此后模块级 watch 读取到的是不再更新的陈旧值。即 TaskView 因路由切换（如进 Settings）卸载再重建后，`setViewingSideTask` / `markSideTaskRead` 不再触发，边路任务「打开即已读」逻辑静默停摆。修复方向：watch 的数据源改为模块级单例（直接 watch `sessionTabsMap` + `currentSessionId` 派生激活 tab），而不是闭包捕获任一实例的 computed。

> 说明：此条依赖 Vue effect scope 对 setup 内 computed 的停止行为（Vue 3.4+ 明确会停止），标注为中等置信度；若 TaskView 在应用中永不卸载则不触发。

---

## 复查过但确认无问题的重点项

以下易错点已逐一推演，确认当前实现正确，供后续 review 免于重复排查：

- `file-change-diff-util.ts` `buildUnifiedPatch` 的 unified diff 头行数（old/new count）在插入/删除/尾部截断各种组合下与实际 hunk 行数一致（尾段统一按旧序号输出的注释是正确的）。
- `edit-file-match.ts` 的出现计数与 `split().join()` 替换语义一致（均按最左非重叠匹配）。
- `compaction-service.ts` `buildSafeResult` 的物理前缀校验、`admin-analytics.service.ts` 的窗口区间 `[startAt, endAtExclusive)` 与环比区间推导（`buildRange(addDaysYmd(startYmd, -1), days)`）均正确。
- `message-queue.service.ts` 的 `FOR UPDATE` 队尾/邻位锁与死锁重试逻辑自洽；`enqueueHead` 递减 `sortOrder` 只会造成负值增长，不影响 FIFO 排序。
- `grep-search-tool.ts` JS 回退分支的上下文去重（`lastPrinted`）与 rg `--context` 语义对齐正确。
- `shell-session-tool.ts` 的 `acquireCommand` 串行化、`write_stdin`/`await_async` 拿锁后重读 `livePending` 的处理正确（唯一小瑕疵：`handleAwaitAsync` L334 settle 用的是拿锁前的 `pending.keepSession`，但 `keepSession` 在命令生命周期内不可变，无实际影响）。
- `agent-cli/src/ws/ws-client.ts` 的 `serializePayload` 二分截断与重连簿记（`settled`/`intentionalClose`/旧 socket 迟到 close）逻辑正确。
- `delivery.scheduler.ts` 的 SENDING 卡死恢复（5 分钟 cutoff + 每分钟节流）与终态回写 CAS（防 WS 抑制态被覆盖）正确。
- desktop `useStreamWS` 断线重连后会遍历 `subscribedSessionIds` 重放订阅，`subscribe()` 在发送失败时仅延迟到下次重连生效，有自愈路径。
