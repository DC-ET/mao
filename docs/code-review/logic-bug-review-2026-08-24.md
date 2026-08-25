# 核心功能逻辑 BUG 审查报告

- 审查日期：2026-08-24
- 审查范围：backend-ts（harness 引擎、WS 流处理、会话/定时任务/子代理委派）、desktop（useStreamWS/useChat/stores）
- 审查方式：全量通读 + 定向验证（BUG-01 已用 croner 实测复现）
- 说明：每条 BUG 均给出位置、根因、触发条件与影响，修复建议仅供参考。

---

## BUG-01 ~~定时任务星期字段语义错位~~（复查后判定为误报，不修复）

**原判断：** Spring cron 数字星期（1=周日）与 croner（1=周一）语义不同，导致触发日期偏移一天。

**复查结论：** 误报。「1=周日」是 **Quartz** 的约定；**Spring** 的 `@Scheduled`/`CronExpression` 使用标准 UNIX 语义：0-7、其中 0 与 7 均为周日，1=周一，与 croner 默认行为一致。项目契约写明「Spring cron 表达式」，因此 `normalizeSpringCron` 仅替换 `? → *` 是正确的，不存在偏移。开发期间已还原试验性映射代码。

**遗留小风险（非缺陷，记录备查）：** 若未来用户按 Quartz 习惯传 `1`（期望周日）会得到周一触发；如需兼容 Quartz 风格，应在产品层显式声明或提供选项，而非在解析层猜测。

---

## BUG-02 ask_user_questions 用子串 `"error"` 判定取消，用户答案内容可误触发

**严重度：中高**
**位置：** `backend-ts/src/harness/tool/tool-dispatcher.ts:157`

```ts
if (result != null && result.includes('"error"')) {
  this.streamingWsRegistry.send(userId, wsEvent('ask_user_questions_cancelled', ...));
  this.treeSignalPublisher.publishForSession(sessionId!);
}
```

**根因：** 成功应答的结果是 `{"answers": <用户原样输入的 JSON>}`，超时/失败结果是 `{"error": ...}`。这里用裸子串 `"error"` 区分两种情况，而 `answers` 内容完全由用户输入拼接而成，没有任何转义隔离。

**触发条件：** 用户回答文本中出现带双引号的 `error` 字样即可命中。例如回答：

> 参考日志里的 \"error\" 行排查

序列化后的 JSON 含 `\"error\"`，其子串恰好包含 `"error"`，判定为真。

**影响：**
- 服务端其实已把答案正确返回给 Agent（`waitForAnswer` 不受影响），但前端会收到 `ask_user_questions_cancelled`，问题面板被当作「已取消」提前移除；
- 同时重复发布 tree 信号，审批/提问计数出现抖动。属于典型的「用数据内容做控制流判断」缺陷。

**修复建议：** 不要解析启发式子串。让 `waitForAnswer` 返回结构化对象（`{ answered: boolean, payload }`），或在注册表中显式区分 timeout/cancel 与 answer 三种终态，由返回值类型而非字符串内容驱动后续事件。

---

## BUG-03 「空响应重试耗尽」异常在适配器回调内抛出，被误判为可重试网络错误

**严重度：中高**
**位置：** `backend-ts/src/harness/core/agent-loop.ts:288-292` 与 `backend-ts/src/harness/llm/openai-llm-adapter.ts:338-349、:634`（`isRetryableNetworkFailure`）

**根因：** AgentLoop 设计了循环级空响应退避：连续 10 次空响应后在 `onComplete` 回调里 `throw new Error('LLM 连续返回空响应，自动重试已耗尽…')`。但该回调是在 `OpenAiLlmAdapter.processStreamBody` 的 try 块内被调用的：

1. 若该轮**只有思考输出**（推理模型常见，`emitted=true`，因为 `hasAccumulatedOutput` 把 `reasoningContent` 也算输出）：异常被包装成 `StreamInterruptedAfterOutputException`；
2. 该异常在 `isRetryableNetworkFailure` 中被显式列为**可重试网络故障**；
3. 于是适配器立刻开始自己的一轮完整重试（最多 `rateLimitMaxRetries` 次，每次指数退避 + `onStreamReset`），而每次重试依旧空响应 → 循环级计数继续递增 → 再次立即抛出 → 再包装……

**影响：**
- 两套重试机制互相打架：本应「10 次空响应后退避停止」，实际变成 适配器重试次数 × 空响应次数 的额外 LLM 调用，白烧 token 与时间；
- 用户最终看到的错误是误导性的「模型流式响应已中断，自动重试已耗尽」，而不是真实的「LLM 连续返回空响应」；
- 仅当空响应完全无任何输出时才走预期的快速失败路径，行为不对称。

**修复建议：** 定义专用异常类型（如 `EmptyResponseExhaustedException`），在 `processStreamBody` 的 catch 与 `isRetryableNetworkFailure` 中显式排除，使其穿透到 AgentLoop 的既有处理；或把「计数耗尽」的判断移出 `onComplete` 回调，改在 `stream()` 返回后由 AgentLoop 判定。

---

## BUG-04 异步后台 shell 结果被 500 字符硬截断且丢失结构化字段，模型无法判断执行成败

**严重度：中**
**位置：**
- 截断源头：`backend-ts/src/harness/core/background-task-manager.ts:17`（`MAX_OUTPUT_LENGTH = 500`）及 `consumeCompletedResults`
- 提交侧（LOCAL）：`backend-ts/src/harness/tool/tool-dispatcher.ts:224-233`（`dispatchLocalShellAsync`）
- 提交侧（CLOUD）：`backend-ts/src/harness/tool/impl/shell-session-tool.ts:154-165`

**根因与不一致：**
1. 同步 `exec` 返回完整 JSON（含 `exit_code`、`completed`、`current_workdir`、最多 10000 字符的 `output`）；
2. 异步路径把「等待输出的任务」提交到后台，最终注入上下文的内容却是 `consumeCompletedResults` 截断到 **500 字符** 的产物：
   - LOCAL 路径后台任务是 `await_async`，其返回值是一段 JSON——先截断再注入，模型拿到的是一段**被拦腰截断、无法解析的坏 JSON**；
   - CLOUD 路径提交的是 `r.output` 纯文本，虽可读但 `exit_code`/`completed` 信息彻底丢失。

**影响：** 模型消费 `<后台任务结果>` 时既拿不到退出码也无法确认是否完成，长输出场景下还会把坏 JSON 当作命令结果理解，直接导致后续决策错误。两条路径行为还不一致（一个纯文本、一个残缺 JSON）。

**修复建议：** 统一异步结果的产出格式：后台任务内先解析 `await_async` 结果、重组为与同步路径同构的精简 JSON（`exit_code`/`completed`/截断后的 `output`），再做长度裁剪；裁剪上限至少应对齐同步路径的预览上限。

---

## BUG-05 队列自动消费路径上校验失败导致消息「已被消费却永不执行」

**严重度：中**
**位置：** `backend-ts/src/session/ws/streaming-ws-handler.ts`
- 出队与占位：`autoConsumeQueue`（约 `:889` 起）
- 校验失败出口：`handleSendMessage` 中「模型不支持图片 / 图片超过 10 张 / LOCAL 未连接」三个分支

**根因：** `autoConsumeQueue` 先 `dequeue` 并把消息持久化为 USER 消息、广播 `queue_message_consumed`，随后以 `executionClaimHeld=true` 调 `handleSendMessage`。该方法顶部即 `autoConsumingSessionIds.delete(sessionId)`，之后若命中以下任一校验：

```ts
if (claimAlreadyHeld) this.executionClaims.delete(sessionId);
this.deps.registry.send(userId, wsEvent('error', ...));
return;
```

- 占位被释放、错误事件发出，但这条队列消息**已经出队、已经落库**，且不会走 `enqueueHead` 回补（回补逻辑只覆盖 `agentExecutor.submit` 同步拒绝的场景，见 `autoConsumeQueue` 的 catch 分支）。

**影响：** 排队的消息被消费后静默丢弃：界面显示用户消息已入列又消失（或残留无回复），任务永不执行。触发条件包括「队列消息带图片 + 当前模型不支持视觉」「LOCAL 模式桌面端恰好断开」等真实场景。

**修复建议：** 对 `claimAlreadyHeld` 路径的所有早退分支统一回补队列（或把校验前置到 `autoConsumeQueue` 出队之前），保证「出队 ⇒ 必然执行 或 必然回补」的不变量。

---

## BUG-06 子代理进度统计被单次流重置清零，check_subagent 观察到指标倒退

**严重度：低中**
**位置：** `backend-ts/src/harness/delegate/subagent-result-collector.ts:18-25`（`onLlmStreamReset`）

```ts
onLlmStreamReset(): void {
  this.contentBuilder.length = 0;
  this.thinkingBuilder.length = 0;
  this.toolCallCount = 0;          // ← 抹掉历史轮次累计
  this.seenToolCallIds.clear();
}
```

**根因：** `SubAgentResultCollector` 的生命周期覆盖整个子代理多轮循环，`toolCallCount` 是跨轮累计值。但 `onLlmStreamReset` 由 LLM 适配器在**单次流内可重试失败**（如思考被截断、中途断流）时触发，语义应当只是「丢弃当前这一轮的半成品输出」。当前实现把此前所有轮次累计的工具调用数一并清零。

**影响：** 子代理运行中途遇到一次网络抖动重试，父代理随后调用 `check_subagent` 时看到 `tool_calls` 从比如 17 倒退回 0~1，进度展示失真；最终落库统计同样偏低。

**修复建议：** `onLlmStreamReset` 只清理本轮缓冲（content/thinking/seenToolCallIds），保留 `toolCallCount` 累计；或在 reset 前先把已确认的工具调用数固化到独立累加器。

---

## 复查过程中排除的疑似项（避免误报）

以下疑点经追踪后确认不是缺陷，记录备查：

1. **`MessageHistoryNormalizer` 丢弃孤儿 TOOL 消息**：DB 中保留原行、仅在构建上下文时剔除，配合 `cleanupIncompleteTail` 语义自洽。
2. **压缩边界快照校验（`buildSafeResult`/`persist` 的 CAS）**：内容快照 + 边界双重校验，竞态下正确回退。
3. **`ActiveContextCalculator` 基于 `messagesCoveredByAnchor` 的切片估算**：压缩后 anchor 被重置（`resetContextAnchor`），索引失效风险已被覆盖。
4. **前端取消后的 `suppressedStreamSessions` 门控**：终态 `session_status` 事件故意绕过门控用于状态对账，设计合理。
5. **`editMessageAndResend` 用 id 单调序定位最后一条用户消息**：已规避 `created_at` 时钟偏移问题。

## 优先级建议

| 编号 | 严重度 | 建议顺序 |
|------|--------|----------|
| BUG-03 | 中高 | P1：双重视试叠加，浪费 token 且错误信息误导 |
| BUG-02 | 中高 | P1：一行级修复收益大 |
| BUG-05 | 中 | P1：队列消息丢失属功能性缺陷 |
| BUG-04 | 中 | P2：统一异步/同步结果契约 |
| BUG-06 | 低中 | P2：统计准确性 |

（BUG-01 经开发期复查判定为误报，见该节说明；原表中已移除。）
