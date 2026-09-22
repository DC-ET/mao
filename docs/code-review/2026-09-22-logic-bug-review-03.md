# 核心功能逻辑 BUG 审查（2026-09-22 16:10）

- **范围**：当前工作区未提交改动（子代理结果先投递再补占位、后台子代理终态条件更新、定时任务档期回滚、微信等待桌面循环退出、飞书重试成功后排空队列）。
- **判定口径**：只收录本轮改动引入的、在可描述时序下会让用户看到错误结果的功能问题。风格、性能、文档不计。上一轮 `2026-09-22-logic-bug-review-02.md` 的 B01–B07 不重复开列。
- **边界**：只读源码与同路径对照，未跑 MySQL / 浏览器 / 外部 IM。
- **修复状态（2026-09-22）**：B01、B02 已按下文「正确预期」修复，并补了回归测试。原文的「现状」保留审查时的样子。

## 问题总览

| 编号 | 级别 | 模块 | 一句话 |
| --- | --- | --- | --- |
| B01 | P1 | weixin | 微信以为桌面循环已经退出，其实桌面还在收尾，两边会一起写同一个会话 |
| B02 | P1 | harness/delegate | 崩溃恢复为了写入子代理结果，把同一条助手消息上的正文和其它工具调用一起删掉 |

---

## B01 [P1] 微信在桌面循环真正退出前就开始执行

**位置**：`backend-ts/src/weixin/agent-inbound-handler.ts:261-279`（等待条件）、`:282-290`（读阶段失败当成「没有阶段」）。桌面收尾在 `backend-ts/src/session/ws/streaming-ws-handler.ts:540-575`，自动消费跳过「会话仍在跑」判断在同文件 `:349`、`:373-376`，延迟开跑在 `:1317-1326`。旗标是整表替换 / 无条件删除：`backend-ts/src/harness/core/agent-loop.ts:73-89`。

等待函数的注释要求先等桌面（或其它非本 handler）循环退出，再 `registerCancelFlag`，避免两边同时 `execute`。实际只要下面任一成立就当成已经退出：

```ts
// agent-inbound-handler.ts:271-276
if (loop.getCancelFlag(sessionId) !== foreign) return true;
const phase = await this.readPhase(sessionId);
if (phase != null && isActivePhase(phase)) sawActive = true;
else if (sawActive) return true;
else if (phase !== undefined && Date.now() - started >= STALE_FOREIGN_FLAG_MS) return true;
```

桌面 `runExecution` 并不是「阶段离开 RUNNING 就结束」。取消路径是先 `finishCancelledSession` 把阶段写成 `CANCELLED`，**然后**才进 `finally`：清掉自己的占用，并 `agentLoop.removeCancelFlag`（按 sessionId 删除，不核对是不是自己那把旗标），队列非空时再 `autoConsumeQueue`。自动消费会在 500ms 后调用 `handleSendMessage`，而这条路径因为 `isAutoConsume === true`，**不看**当前阶段是不是已经又变成 `RUNNING`。

**触发条件**：

1. 桌面正在跑，用户从微信发来一条消息（本轮要修的场景）。桌面把阶段写成 `CANCELLED` 的那一下，`sawActive` 分支立刻返回。微信注册新旗标并开始执行。桌面 `finally` 随即 `removeCancelFlag`，把微信刚放进 Map 的旗标删掉；若桌面队列里还有消息，500ms 后自动消费再注册一把旗标并 `execute`。微信没有登记桌面的 `executionClaims`，这道「已有执行」挡不住它。
2. 桌面旗标已经注册，但还没把阶段写成 `RUNNING`（执行器排队超过 1 秒，阶段仍是 `IDLE` / `COMPLETED`）。1 秒后微信直接开跑。排上队的桌面循环拿着自己那把已经置位的旗标进入 `runExecution`，先无条件 `updatePhase(RUNNING)`，循环一进来又因为旧旗标为 true，把 Map 里微信的旗标也置上（`agent-loop.ts` 的 `resolveCancelFlag`），然后 `finishCancelledSession` 发现阶段不是终态，再写成 `CANCELLED`。微信这边 `cancelFlag.get()` 为 true，按 `resolve(null)` 结束，用户收不到回复。
3. 已经看到过活跃阶段之后，`getSession` 抛一次错。`readPhase` 的 `catch` 返回 `null`，`null` 不是活跃阶段，`sawActive` 分支同样立刻返回。此时桌面循环还在跑。

**错误结果**：同一个会话上出现两段执行，消息和阶段写到一起；或者微信这句被桌面迟到的收尾改成已取消，微信侧没有回复。这和本次改动注释里写的互斥意图相反。

**正确预期**：在桌面循环的 `finally`（含它排队的自动消费真正开始或明确放弃）结束之前，不要替换取消旗标，也不要 `execute`。阶段暂时不是活跃、读阶段失败、旗标对象换成另一把，都不能当成「已经退出」。

**确信依据**：阶段写入点和 `removeCancelFlag` / `autoConsumeQueue` 不在同一时刻；自动消费明确跳过活跃阶段检查。等待条件与这段收尾对不上。

---

## B02 [P1] 恢复投递按「整段重建」写入子代理结果，同轮其它内容被删掉

**位置**：先投递再补占位 `backend-ts/src/harness/delegate/subagent-recovery-coordinator.ts:60-67`；占位视为未完成 `backend-ts/src/harness/delegate/subagent-result-delivery.service.ts:250-252`；拆掉并重建 `同文件:68-102` 与 `:255-275`。

本轮把恢复顺序改成先 `deliver`，再 `cleanupIncompleteTailAfterId`，并且工具内容等于「结果丢失」占位时也算未完成。这两处都会走进原来的 `!existing.complete` 分支：

```ts
// subagent-result-delivery.service.ts:68-88
if (!existing.complete) {
  await this.removeIncompletePair(tx, parentSessionId, toolCallId);
  assistantId = await tx.insert('message', {
    ...
    content: '',
    toolCalls: JSON.stringify([{
      id: toolCallId,
      function: { name: 'delegate', arguments: ... },
    }]),
```

`removeIncompletePair` 会软删**整条**带这个 `toolCallId` 的助手消息，以及这个 id 的 TOOL 行。重建只插入一条正文为空、只含这一次 `delegate` 的助手消息，和一条子代理结果。

改顺序之前，崩溃窗口里通常还没有 TOOL 行，`cleanup` 会先只给缺结果的那个 id 补占位，原助手消息还在；`deliver` 看见「助手 + TOOL」就认为已完整，不会拆这条消息（代价是占位挡住了真实结果，即上一轮 B01）。现在 `deliver` 先跑，缺的是 TOOL 行，或者库里已经是占位，都会被当成未完成而整段拆掉。

**触发条件**：父会话已经落下带 `delegate` 的助手消息，进程在写出 TOOL 结果前重启。这条助手消息上还有正文，或者同一次回复里还有别的工具调用（读文件、搜索等）并且那些 TOOL 结果已经落库。这是委托执行里最长的崩溃窗口，不要求额外并发。

**错误结果**：父会话续跑时，该轮助手正文没了；其它工具调用的结果变成没有对应 `tool_calls` 的孤儿 TOOL，之后组历史时会被丢掉。模型只看到一次空的 `delegate` 和子代理结论，已完成的同轮工具等于没发生过。子代理真实结果本身可以写回去，但同轮上下文丢了。

**正确预期**：只替换缺失或占位的那条 TOOL，保留原助手消息（正文、思考、同轮其它 tool call）。不要用一条只含 `delegate` 的空消息换掉整轮。

**确信依据**：`removeIncompletePair` 按「助手消息里包含该 id」删除整行；重建的 `content` 固定为 `''`，`toolCalls` 固定只有一个元素。先投递使「还没有 TOOL 行」的标准崩溃窗口必然走到这个分支。
