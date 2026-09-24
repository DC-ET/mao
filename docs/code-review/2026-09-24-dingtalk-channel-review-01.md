# 钉钉通道 — 代码审查

- 状态：下列 3 条已在同一次开发中修复，复查未再发现重大功能问题。
- 审查日期：2026-09-24
- 对照：`docs/plan/2026-09-24-dingtalk-channel-technical-design.md`
- 审查范围：未提交的钉钉通道实现（`backend-ts/src/dingtalk`、工具过滤、`create-app` 接线、会话分组、管理端与设置页逻辑）
- 未纳入：页面样式、文档与 CHANGELOG
- 结论：绑定、去重、引用不切会话、独立文件不跑 Agent、群上下文标题、非发送者拒点、工具过滤这几条主路径是对的。下面 3 条会让重试拿不到正文，或让私聊 `---` 之后旧任务继续往同一聊天里回复。

## 严重度汇总

| # | 问题 | 严重度 | 位置 |
|---|---|:---:|---|
| 1 | 失败重试的终态正文发不出去，进度卡会被改成失败 | 高 | `agent-inbound-handler.ts` `runRetry`，`runtime.ts` `onReply` |
| 2 | 进度卡「重试」回包前不判断能不能重试，不可用时没有 toast | 中 | `card-action.service.ts` `decideProgress` |
| 3 | 私聊 `---` 之后，旧会话里排队的消息仍会执行并回复到同一私聊 | 中 | `agent-inbound-handler.ts` `openNewSession`、`executeWithSession` |

---

## 1. 失败重试发不出终态正文，还会把进度卡改成失败

**位置**：`backend-ts/src/dingtalk/agent-inbound-handler.ts` `runRetry`（约 316–344 行）；`backend-ts/src/dingtalk/runtime.ts` `onReply`（约 319 行）、`noteReplyFailure`（约 320–329 行）、`cardProgress`（约 176–185 行）

设计要求终态另发一条 markdown，正文不进卡片。普通入站做到了：`onReply` 用上下文里的 `accountId`、会话和发送者去发。重试没有这条上下文，用的是写死的空壳，`accountId` 为 `'0'`，`conversationId` 和 `senderUserid` 都是空的。

```320:342:backend-ts/src/dingtalk/agent-inbound-handler.ts
    const stub = { accountId: '0', chatType: 'p2p', conversationId: '', messageId: '', senderUserid: null, ... } as DingtalkInboundContext;
    // ...
      await cardListener.complete(text);
      if (text) await this.reply(stub, text, sessionId);
      await this.options.afterDelivery?.(sessionId, 'COMPLETED');
```

```319:329:backend-ts/src/dingtalk/runtime.ts
    onReply: (context, text) => sendText(Number(context.accountId), context, text),
    noteReplyFailure: async (sessionId, reason) => {
      const row = await progressRepo.findBySessionId(sessionId);
      // ...
      await updateCard(..., { status: 'failed', detail: `回复发送失败：${reason}`, ... });
    },
```

`sendText(0, …)` 找不到机器人，发送抛错。`reply` 捕获后调用 `noteReplyFailure`。这一步是按进度卡表里的真实 `botId` 更新的，所以卡片会被改成「处理失败 / 回复发送失败」，尽管任务本身已经成功。接着 `afterDelivery('COMPLETED')` 删掉 `dingtalk_progress_card` 这一行。用户在钉钉里看到失败卡，点重试也定位不到原卡。

失败重试的错误文案走同一条空壳回复，同样发不出去；卡片上的失败状态还在，所以这一条的影响主要在成功重试。

**触发**：进度卡处于失败，原发送者点「重试」，续跑成功并生成了回复。

**建议**：重试用进度卡行上的 `botId`、`chatType`、`conversationId`、`senderUserid` 组装发送目标，不要用空壳上下文。发送失败只把原因写进卡片 `body`，不要把已成功的任务改成 `failed`，也不要在这时删掉映射。

---

## 2. 进度卡「重试」不可用时没有 toast，卡片已被改成正在重试

**位置**：`backend-ts/src/dingtalk/card-action.service.ts` `decideProgress`（约 75–83 行）

设计：会话正在执行或已经结束时，toast 提示不可用，卡片保持原样。取消、插队的重活放在回包之后是对的；能不能重试只要读一次阶段，应该在回包前做完。

现在回包固定返回 `status=running`（「正在重试，请稍候…」），真正的 `retryExecution` 放在 `after` 里，返回值也没有用。阶段不是 `FAILED`、或会话正忙时，重试直接被丢掉，回调里又没有 toast。钉钉已经按回包把卡片改成「正在处理」。

```75:83:backend-ts/src/dingtalk/card-action.service.ts
    if (actionId === 'retry') {
      // ...
      return {
        response: cardCallbackResponse(progressCardParams({
          status: 'running', round: 0, detail: '正在重试，请稍候…', ...
        })),
        after: async () => { await retry(progress.sessionId); },
      };
    }
```

排队卡的「立即发送 / 取消本条」会先改队列状态，非发送者会被拒绝。进度卡取消也会先看发送者。缺的是重试这条。

**触发**：失败卡仍在，但会话已经不是 `FAILED`（例如上一轮其实已完成，或正在跑），原发送者点「重试」。

**建议**：回包前 `await retryFailed`。`BUSY` / `NOT_FAILED` / `NO_PROGRESS` 时只回 toast，`cardParamMap` 置空。确认可以重试后，再回「正在重试」的变量。

---

## 3. 私聊 `---` 之后，排队消息仍在旧会话里执行

**位置**：`backend-ts/src/dingtalk/agent-inbound-handler.ts` `openNewSession`（约 186–199 行）、`executeWithSession`（约 236–238 行）

设计：私聊 `---` 成为该私聊唯一活跃会话；正在执行时先取消当前任务再新建；同一私聊不会有两条执行并行。空闲时换指针、群里的 `---` 当普通文本，这两点是对的。

执行中的 `---` 只对当前这一轮置取消标志并把 `dingtalk_chat.session_id` 指到新会话。取消收尾后，旧会话的 `executeWithSession` 仍会在阶段不是 `FAILED` 时排空队列。队列载荷里保存的是原来的 `conversationId`，回复还是发回这同一个私聊。互斥锁按 `sessionId`，新会话上的新消息可以和旧会话的出队同时跑。

```186:195:backend-ts/src/dingtalk/agent-inbound-handler.ts
    if (active != null) {
      this.cancel(active.id);
      await this.options.settleCancel?.(active.id);
    }
    try {
      const created = await control.createSession(context.accountId, context);
      return { intercepted: true, confirm: NEW_SESSION_CONFIRM_TEXT, sessionId: created.id };
```

```236:238:backend-ts/src/dingtalk/agent-inbound-handler.ts
    if (executed) {
      void this.flushAttachmentsAndDrain(session.id, session.executionUserId ?? context.maoUserId ?? null, phase !== 'FAILED')
```

**触发**：私聊里一条任务还在跑，用户又发了消息（已入队），然后发送 `---`。确认文案发出后，排队的那条仍用旧会话上下文回答；若接着再发新问题，两条会并行回复到同一私聊。

**建议**：`---` 切指针时，取消该私聊旧会话上仍为 `QUEUED` 的行，并等当前这一轮退出后再允许新会话开跑。不要在取消之后继续 `drainNext`。
