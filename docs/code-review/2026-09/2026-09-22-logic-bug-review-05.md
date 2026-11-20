# 核心功能逻辑 BUG 审查（2026-09-22 17:35）

- **范围**：当前工作区未提交改动。对照 `2026-09-22-logic-bug-review-04.md`：旗标已摘掉时也会看阶段并走安静窗口，那条入口缺口已经盖住。
- **判定口径**：只收录仍会在可描述时序下让用户看到错误结果的功能问题。
- **边界**：只读源码，未跑 MySQL / 浏览器 / 外部 IM。
- **修复状态（2026-09-22）**：B01 已按下文「正确预期」修复，并补了回归测试。原文的「现状」保留审查时的样子。

## 问题总览

| 编号 | 级别 | 模块 | 一句话 |
| --- | --- | --- | --- |
| B01 | P1 | weixin | 执行在进入代理循环前失败时，取消旗标留在 Map 里，之后每条微信都要空等 60 秒 |

---

## B01 [P1] 没进代理循环的失败会留下旗标，后续微信一直被当成「桌面还在跑」

**位置**：注册旗标 `backend-ts/src/weixin/agent-inbound-handler.ts:182-183`；失败收尾只删 handler 自己的 Map `:234-237`。等待把「Map 里还有别人的旗标」一律当成未退出 `:283-286`。旗标只有进了 `AgentLoop.execute` 才会在 `finally` 里删掉：`backend-ts/src/harness/core/agent-loop.ts:455-459`。`HarnessService.execute` 在那之前就会抛：`harness-service.ts:263-277`（会话 / 智能体 / 模型不存在）。

```ts
// agent-inbound-handler.ts:182-183、234-237
const cancelFlag = this.deps.agentLoop!.registerCancelFlag(sessionId);
this.cancelFlags.set(sessionId, cancelFlag);
try {
  // updatePhase、建 listener、harness.execute …
} finally {
  if (this.cancelFlags.get(sessionId) === cancelFlag) {
    this.cancelFlags.delete(sessionId);
  }
}
```

`finally` 不调用 `agentLoop.removeCancelFlag`。`buildContext` 在 `agentLoop.execute` 之前抛出时，循环的 `finally` 没机会跑，Map 里的旗标一直在。阶段随后会被写成 `FAILED`（空闲），但等待条件是「有旗标就继续等」，空闲阶段清不掉它。60 秒到点只返回失败，不摘旗标。

**触发条件**：微信消息已经注册了取消旗标，接着在进入代理循环之前失败。例如会话绑定的模型已被删掉，`buildContext` 抛出模型不存在。第一条消息会正常走失败回复。从第二条开始，`waitForForeignLoop` 看到上一把旗标还在，阶段又不是运行中，于是空等到 60 秒，回滚这条用户消息，回复「当前会话仍在执行，请稍后再发」。旗标仍在，每条新消息都重复这一轮。

**错误结果**：模型（或同类的执行前失败）修好之前，这个微信会话的新消息都会被丢掉，用户每次要等满一分钟，看到的原因是「仍在执行」。进程重启前不会自己恢复。

**正确预期**：这次执行没有真正跑起来、或已经结束时，把 `AgentLoop` 上这把旗标摘掉。等待超时或阶段已空闲且没有人在收尾时，也不要让一把不会再被摘掉的旗标挡住后续消息。

**确信依据**：`registerCancelFlag` 在 `try` 里，`AgentLoop.execute` 的 `finally` 包不住 `buildContext`。微信的 `finally` 只删自己的 Map。等待循环对「非本 handler 的旗标」没有别的退出条件，只有 60 秒超时，且超时不删旗标。
