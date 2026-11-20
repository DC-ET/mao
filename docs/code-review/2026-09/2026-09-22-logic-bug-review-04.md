# 核心功能逻辑 BUG 审查（2026-09-22 17:05）

- **范围**：当前工作区未提交改动。对照 `2026-09-22-logic-bug-review-03.md` 的修复再看一遍。
- **判定口径**：只收录仍会在可描述时序下让用户看到错误结果的功能问题。03 的 B02（只补缺失的那条 TOOL、保留同轮正文和其它工具调用）已按预期改掉，不再列入。
- **边界**：只读源码与同路径对照，未跑 MySQL / 浏览器 / 外部 IM。
- **修复状态（2026-09-22）**：B01 已按下文「正确预期」修复，并补了回归测试。原文的「现状」保留审查时的样子。

## 问题总览

| 编号 | 级别 | 模块 | 一句话 |
| --- | --- | --- | --- |
| B01 | P1 | weixin | 桌面旗标已经摘掉、收尾还没结束时，微信不等安静窗口就开跑 |

---

## B01 [P1] 没有旗标就当成桌面循环已经退出

**位置**：`backend-ts/src/weixin/agent-inbound-handler.ts:266-271`（入口直接返回）、`:276-289`（安静窗口只在循环里）。桌面在 `execute` 返回时就摘旗标：`backend-ts/src/harness/core/harness-service.ts:89-90`。阶段要等这之后的 `finishCancelledSession` / `finishCompletedSession` 才写成终态（`streaming-ws-handler.ts:540-545`、`:1550-1555`）。队列自动消费再晚 500ms 才注册新旗标（同文件 `:1317-1326`），并且 `isAutoConsume` 不看会话是不是又在跑（`:349`、`:373-376`）。

已经在等的那条路径是对的：别人的旗标还在、阶段仍活跃、或读阶段失败，都继续等；旗标消失且阶段空闲后，还要再安静 800ms（`FOREIGN_LOOP_QUIET_MS`），用来盖住那 500ms。

入口不是这条路径：

```ts
// agent-inbound-handler.ts:269-271
const foreign = loop.getCancelFlag(sessionId);
if (foreign == null || foreign === own) return true;
```

这里不读阶段，也不走安静窗口。`HarnessService.execute` 在代理循环一返回就 `removeCancelFlag`，此时 `runExecution` 还没把阶段写成终态，`autoConsumeQueue` 也还没跑。从这一刻到下一把旗标注册，Map 里是空的。

**触发条件**：

1. 桌面循环刚刚从 `execute` 返回，正在 `cleanupIncompleteTail` 或写终态，阶段仍是 `RUNNING`，旗标已经没了。这时微信消息进入 `waitForForeignLoop`，看到 `foreign == null` 直接开跑。桌面收尾接着 `updatePhase(CANCELLED/COMPLETED)`。微信循环读到终态会自己停下（`agent-loop.ts` 里按库里的阶段取消），`resolve(null)`，用户看不到回复。
2. 桌面阶段已经是终态，队列里还有消息，自动消费处于那 500ms 延迟里，旗标同样还没注册。微信同样直接开跑并 `registerCancelFlag`。500ms 到了以后自动消费再注册一把旗标并 `execute`，而且不因为阶段已是 `RUNNING` 而放弃。两边一起写同一个会话。

微信消息若在旗标还拿着的时候就已经在等，会进入下面的安静循环，盖得住这段收尾。本条是「收尾已经开始、旗标已经摘掉」之后才进来的消息。用户看到桌面任务结束再发微信，正好落在这个窗口。

**错误结果**：这句微信没有回复，或和桌面队列里的下一条同时执行，消息和阶段写到一起。和同函数注释「等 finally 里的自动消费开始或明确放弃后再开跑」不一致。

**正确预期**：入口和循环里用同一套条件。Map 里没有旗标时，也要先看阶段；阶段仍活跃、或刚变成空闲但还没过安静窗口，都不要 `registerCancelFlag`。

**确信依据**：`removeCancelFlag` 在 `execute` 的返回点，终态写入和 500ms 自动消费都在它后面。入口把「没有旗标」单独当成退出，安静窗口到不了这些消息。
