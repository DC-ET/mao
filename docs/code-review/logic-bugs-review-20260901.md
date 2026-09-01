# 逻辑 BUG 审查报告（backend-ts）— 2026-09-01

- 审查范围：`backend-ts/src` 全量走读 + 定向复核。基线：commit `d4b8982` + 当前工作区未提交改动（即 `code_review_20260901073332.md` 所审查的 6 项修复已计入现状）。
- 方法：只报告有代码证据、可复现推演的功能逻辑缺陷；对触发条件偏窄的条目如实标注。不包含风格/性能/口径类问题（另见「已排查确认无问题」）。
- 本文与 `docs/code-review/` 既有 100+ 份文档做过标题与关键词去重（见文末「去重核查说明」）。

---

## 一、中严重度

### BUG-1【中·微信】`AgentWeixinInboundHandler.withSessionLock` 清理条件永假 → `sessionLocks` 按会话永久泄漏

- **位置**：`backend-ts/src/weixin/agent-inbound-handler.ts:274-286`；相关字段 `:65-66`（`generations` / `sessionLocks`）。
- **触发条件**：任意一条微信消息执行完毕即触发（`finally` 中清理判断恒为假）。
- **关键代码**：

  ```ts
  private async withSessionLock(sessionId: number, fn: () => Promise<void>): Promise<void> {
    const prev = this.sessionLocks.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((r) => { release = r; });
    this.sessionLocks.set(sessionId, prev.then(() => current));   // 存入的是 chained
    await prev;
    try {
      await fn();
    } finally {
      release();
      if (this.sessionLocks.get(sessionId) === current) this.sessionLocks.delete(sessionId);  // 与 current 比较 → 永假
    }
  }
  ```

  Map 中存入的是 `prev.then(() => current)`（新 Promise），`finally` 却与 `current` 比较，条件永远不成立，条目永不删除。
- **后果**：`sessionLocks` 中每个出现过的微信会话各残留一条已 resolve 的 Promise，随历史会话数线性累积、进程生命周期内不回收。锁的互斥功能本身仍正确（链式等待成立，且 `current` 永不 reject、无 unhandled rejection），属纯泄漏型缺陷，量级 = 历史微信会话数。
- **同源说明**：这是与 schedule 侧完全同型的笔误——`scheduled-task.service.ts:88-106` 的同名函数**已在当前未提交改动中修复**（存入 `chained` 并与 `chained` 比较），`file/git-write-operation.service.ts:279-291` 的 `withRepoLock` 也是正确参照；唯独微信入站侧漏改。
- **附注**：同文件的 `generations`（`:264-267`）只 `set` 从不 `delete`，同样只增不减（量级亦为会话数），可随本条一并治理。
- **修复建议**：对照 `scheduled-task.service.ts:88-106` 原样移植：`const chained = prev.then(() => current, () => current); this.sessionLocks.set(sessionId, chained);` 并以 `=== chained` 判删。

### BUG-2【中·微信】换代跳过时留下孤立的 USER 消息，无回复也无清理，持续污染 LLM 历史

- **位置**：`backend-ts/src/weixin/agent-inbound-handler.ts:97-131`（`onMessage` 落库）与 `:142-146`（`runAgent` 锁内代次校验跳过）；对照取消分支 `:168-176`（会调 `finishCancelledSession` 清理）。
- **触发条件**：同一微信会话中，上一轮执行尚未结束（或 `runAgent` 仍在 `withSessionLock` 排队）时用户连发两条消息 A、B：
  1. A 到达：`nextGeneration()`（gen=2）→ `saveMessage(USER_A)` 落库 → 提交 `runAgent(A)`，在锁上排队；
  2. B 到达：`nextGeneration()`（gen=3）→ A 的 `runAgent` 随后进入锁，`isCurrentGeneration(sessionId, 2)` 为 false → `resolve(null); return`。
- **关键代码**（`:142-146`）：

  ```ts
  await this.withSessionLock(sessionId, async () => {
    if (this.stopped || !this.isCurrentGeneration(sessionId, generation)) {
      console.info(`微信消息已被更新消息取代, sessionId=${sessionId}, gen=${generation}`);
      resolve(null);
      return;                      // 直接跳过：USER_A 已在 :122 落库，无人清理
    }
  ```

- **后果**：会话历史中永久留下一条没有任何 ASSISTANT 回复的 USER 消息（B 正常执行后形成连续两条 USER）。`cleanupIncompleteTailAfterId` / `cleanupIncompleteTail` 只裁剪不完整的 assistant+tool_calls 尾巴，不会删除孤立 USER，因此该消息会进入此后每一轮 LLM 请求：模型会看到一条「从未被回应的提问」，可能回头补答旧消息、混淆轮次语义。Anthropic 侧 `convertMessages` 会把相邻 USER 合并成一条（不报 400），OpenAI 侧原样发送连续 user（多数网关接受），所以表现为静默的上下文污染而非报错，更难被发现。
- **对照**：`code_review_20260807234700.md` 记录并修复过 **delegate 子会话**追问路径的同类问题（落库前清理尾部孤立 USER）；微信入站路径无对应处理。
- **修复建议**：在锁内跳过分支补清理——按 `savedMessage.id` 回滚本轮 USER 消息并调 `finishCancelledSession`（或等价的终态收尾）；也可将 `saveMessage` 延迟到拿到锁且通过代次校验之后再落库。

### BUG-3【中·WS】`handleRetryExecution` 在 `cleanupIncompleteTail` / `updatePhase('RESUMING')` 抛错时不释放 `executionClaims` → 会话永久 busy

- **位置**：`backend-ts/src/session/ws/streaming-ws-handler.ts:748`（add）、`:764`（cleanupIncompleteTail）、`:769`（updatePhase RESUMING）；无 try/catch 保护。对比：`submitExecution` 的 catch（`:368-372`）只兜底「提交被拒」；WS dispatch 外层 catch 仅 `console.error`（`code_review_20260901073332.md` 亦确认该 catch 静默吞错）。
- **触发条件**：用户对终态会话点击「重试」，`executionClaims.add`（`:748`）之后、`submitExecution`（`:778`）之前的任一 await 抛异常——`cleanupIncompleteTail` 或 `updatePhase('RESUMING')` 遇到 DB 抖动/死锁/连接池耗尽等即满足。
- **关键代码**（`:744-778` 摘录）：

  ```ts
  if (this.executionClaims.has(sessionId)) { this.sendSessionAlreadyRunning(...); return; }
  this.executionClaims.add(sessionId);
  this.deps.registry.subscribe(userId, sessionId);
  if (session.executionMode === 'LOCAL') {
    ...
    this.executionClaims.delete(sessionId);   // 仅 LOCAL 未连接这一个分支会释放
    ...
  }
  const deleted = await this.deps.sessionService.cleanupIncompleteTail(sessionId);  // 抛错 → claim 泄漏
  ...
  await this.deps.sessionService.updatePhase(sessionId, 'RESUMING');                // 抛错 → claim 泄漏
  ...
  this.submitExecution(...);   // 仅同步提交失败时才会在 catch 中 delete（:368-372）
  ```

- **后果**：claim 永久残留，此后该会话所有 send / retry / 队列消费全部命中 `session_already_running`（`:135`、`:744`、`:982` 等互斥检查），只能重启进程恢复。与 M-4（`logic-bugs-full-scan-20260830.md`，仅覆盖 `handleSendMessage` 的 saveMessage/prepareMessage 路径，现 `:297-338` 已修）及 `logic-bugs-review-20260824.md:275`（`handleCreateSideSession` 的 agentExecutor 拒绝，`:648` 路径已修）互不重叠——retry 路径的**前置 await 异常**是同一根因的第三处漏改。
- **修复建议**：复制 `handleSendMessage` 的修复模式：记录 `claimAlreadyHeld`，把 `:749-777` 段包进 try/catch，异常时 `executionClaims.delete(sessionId)` 并回发 error 事件后再抛出/返回。

### BUG-4【中·通知】WAITING_WS 抑制窗口仅 10 秒，CAS 竞态下 WS 已送达的通知仍会补发 webhook（重复投递）

- **位置**：
  - `backend-ts/src/notification/task/delivery.service.ts:76-78`：`prepare` 落库 `status=WAITING_WS`、`nextRetryAt = now + 10_000`；
  - `backend-ts/src/notification/task/delivery.scheduler.ts:31-36`：`listDue` 把 `WAITING_WS AND next_retry_at <= now` 与 PENDING 一并捞出，`:87-97` `claim` CAS 成 SENDING 后立即 `deliver` 发 webhook；
  - `backend-ts/src/session/task-terminal.service.ts:65-76`：`sendWithResult(...).then(result => notificationExecutor(() => resolveWebSocket(delivery, delivered(result)))`；
  - `backend-ts/src/notification/task/delivery.service.ts:106-108`：`resolveWebSocket` 用 `updateIfStatus(id, WAITING_WS, patch)` CAS，状态已非 WAITING_WS 时**静默丢弃 patch**。
- **触发条件**（时序竞态）：终态通知创建后，`resolveWebSocket` 的落库晚于 10 秒窗口到期。现实路径至少有两条：
  1. `sendWithResult` 的 `resultFuture` 要等 `outboundQueue` 出队冲刷才 resolve（`streaming-ws-registry.ts:147-160`）；队列积压/容量告警/事件循环繁忙时 resolve 可超过 10s——而此时 WS 事件**实际已送达客户端**；
  2. `notificationExecutor` 默认是微任务（`task-terminal.service.ts:20-22`），但 `resolveWebSocket` 中的 DB 写在负载高时同样可能拖过 10s。
  窗口到期后 scheduler tick 把该行 `claim` 成 SENDING 并发 webhook；随后 `resolveWebSocket` 的 CAS 失败、patch 被丢弃，用户在已收到 WS 终态通知的情况下再收到一次 webhook。若 webhook 首投失败，`recoverInterruptedDeliveries`（5 分钟 cutoff 把 SENDING 复位 PENDING）还会再多补一轮。
- **后果**：终态任务通知重复投递（WS + webhook 各一次）。正常路径（无连接时 `sendWithResult` 立即 resolve 0/0/0）不受影响，**触发窗口偏窄，如实标注**；但队列积压正是该模块存在的意义，积压场景下抑制机制恰恰最先失效。
- **去重说明**：`bug-claims-verification-20260831.md:27` 论证的是「listDue 排除 SENDING + eventKey 唯一键」下单实例不会重复投递，未覆盖本条「WAITING_WS 到期被 claim」的竞态；`logic-bugs-review-20260824.md` BUG-13（无条件覆盖终态、已修）是另一问题。
- **修复建议**：方向任选其一或组合：① 把 WAITING_WS 的 `nextRetryAt` 从 10s 提到 ≥60s（缓解）；② `resolveWebSocket` CAS 失败时若 `delivered=true` 且当前状态为 SENDING，则补写 `SUPPRESSED_WS` 并跳过 webhook（需要 webhook 发送前二次确认状态）；③ scheduler 对 WAITING_WS 行先延迟确认（如要求连续两个 tick 仍到期才 claim）。

---

## 二、低严重度

### BUG-5【低·工具】`grep_search` 无 rg 回退分支与 rg 分支行为/输出结构不一致，`**/*.ext` 在回退分支漏匹配根目录文件

- **位置**：`backend-ts/src/harness/tool/impl/grep-search-tool.ts:56-58`（分支选择）、`:98-123`（rg 分支）、`:128-165`（`searchWithJs` 回退）、`:175-177`（`globToFileRe`）。
- **触发条件**：部署环境无 `rg` 可执行文件（`isRgAvailable()` 返回 false）且使用 `glob: "**/*.md"` 类模式或 `context_lines > 0`。
- **问题**：
  1. **glob 语义差异**：`globToFileRe("**/*.md")` 生成 `^.*.*/.*\.md$`，要求相对路径中至少含一个 `/`，根目录文件（如 `README.md`）不匹配；而 rg 的 `--glob '**/*.md'` 遵循 gitignore 语义、匹配零层或多层目录，根目录文件**会**命中。同一调用在两种环境返回不同结果集（回退分支静默漏文件）。
  2. **输出结构差异**：rg 分支把上下文行作为独立条目输出并打 `contextual: true` 标记（`:113`）；JS 分支把上下文放进 `context_before` / `context_after` 数组（`:151-152`）。消费方按同一 schema 解析时，回退环境下上下文信息形态完全不同。
  3. **无大小防护**：回退分支 `readFileSync(file, 'utf8')` 全量读入（`:145` 附近），对大文件无上限；rg 分支由 `spawnSync maxBuffer 10MB` 兜底。
- **后果**：工具行为随部署环境漂移；无 rg 的环境下 `**` 类 glob 结果不完整（漏根目录文件）、上下文字段名不同，且极端情况下可读入超大文件。
- **对照已修**：`logic-bugs-review.md:201` 记录的「回退 walk 缺 node_modules/.git 跳过」现已通过 `IGNORED_DIRS`（`:190`）修复，与本条无关。
- **修复建议**：`globToFileRe` 将 `**/` 前缀归一化为可选段（`(?:.*/)?`）；统一上下文输出结构（建议回退分支也输出独立 context 条目 + `contextual: true`）；回退分支加单文件读取上限。

---

## 三、已排查确认无问题 / 不重复报告事项（避免后续重复排查）

以下线索本轮已逐一核实，**不构成可报告的逻辑 BUG**或已被既有文档记录：

1. **LOCAL 模式 MCP 注入传参矛盾**（`harness/core/harness-service.ts:321-324` 传 `this.mcpClientManager ?? null`，`mcpClientManager` 恒非 null，违反 `mcp-tool-adapter.ts:16`「clientManager 为 null 即 LOCAL」注释约定，`descriptor.executor` 变成 `'mcp-server'` 而非 `'desktop'`）：`ToolDispatcher.dispatchFull` 的 LOCAL 路由只看 `executionMode`（`tool-dispatcher.ts:163-178`），`ToolDescriptor.executor` 字段全库无生产消费方，adapter.execute 的兜底分支在 LOCAL 下不可达——**无行为影响**，仅注释/字段语义与实现矛盾，记录备查。
2. **`McpSyncService.nameToId` 全局 Map 无用户隔离/无清理**：已被 `code_review_20260821093505.md:86` 记录，不可重复报告。
3. **`mcp-client-manager.ts:97-100` `buildTransport` 的 SSE 回退不可达**（`StreamableHTTPClientTransport` 构造不发起网络 I/O，真正连接在 `client.connect` 处，catch 分支实际永不触发）：与已记录的 L-9（HTTP MCP 不遵循 Streamable HTTP 协商）相邻，未确认是否属同一问题的不同表述，按去重原则不重复报告；建议随 L-9 一并处理。
4. **`streaming-ws-registry.ts:168` `sendRaw` 不调 `flushNow`**：全后端无任何调用方（死代码），且 `scheduleDrain` 50ms 兜底，无影响。
5. **`activeToolCalls` 泄漏**（候选）：WsStreamingEventListener 的 4 处退出路径均有 `clearActiveToolCalls`，`unregister` 在最后一条 socket 断开时清理 `userSubscriptions`，证据不足，不成立。
6. **`isCompletePhysicalPrefix` 的 `snapshotMessageIds` 空数组分支**（候选）：`session-history-loader.ts` 中 snapshot 与 `persistedMessages` 同源同长，且 `session-compaction-orchestrator.ts` 已先判空返回，条件不可达，不成立。
7. **`tool_call_args_delta` 全量/增量语义**（候选）：后端传累积全量（`agent-loop.ts:229-235`）→ listener 覆盖式下发 → desktop `updateToolCallArgs` 覆盖式赋值（`stores/session.ts:1297-1306`），三端一致，不成立。
8. **statistics/analytics N+1、token 双算、compaction `savedTokens` 硬编码 0**：性能/展示口径类，非功能逻辑缺陷。
9. **LDAP 并发首登竞态**（`ldap-auth.service.ts:64-71` 先查后插、`user.repository.ts` 无 ON DUPLICATE 容错）：同用户并发首次登录可能触发唯一键冲突、一方报「LDAP 认证失败」，重试即恢复，属自愈型低概率边界。
10. **shell 会话归属校验缺失**（`shell-session-tool.ts` `handleWriteStdin`/`handleClose` 与 `shell-session-manager.ts:291-302` `getOrCreate` 均不校验 `conversationId` 归属）：会话 ID 形如 `sh-{convId}-{ts}-{8位hex}`（`:312-313`），跨用户猜测不可行，同用户跨会话复用多发生在共享同一工作区的场景，列为此处观察项，不计入 BUG。

---

## 四、修复优先级建议

| 序号 | 条目 | 严重度 | 修复成本 | 建议 |
| --- | --- | --- | --- | --- |
| 1 | BUG-3 retry claim 泄漏 | 中 | 低（补 try/catch，照抄 M-4 修复模式） | **最先修**：后果最重（会话永久不可用）且修复模式现成 |
| 2 | BUG-1 微信锁泄漏 | 中 | 低（3 行，照抄 schedule 侧已修实现） | 随下一批改动顺手修，与 schedule 侧修复同批提交 |
| 3 | BUG-2 微信孤立 USER | 中 | 中（需设计回滚/延迟落库） | 与 BUG-1 同文件同批修，注意补单测 |
| 4 | BUG-4 通知 10s 窗口 | 中 | 中（涉及投递协议微调） | 先做 ②（CAS 失败补救）+ ①（拉长窗口）组合 |
| 5 | BUG-5 grep 回退差异 | 低 | 低 | 环境相关，可与工具层其他收尾一并处理 |

## 去重核查说明

- 比对基线：`docs/code-review/` 全部既有文档标题 + 关键词 grep（`withSessionLock`、`isCurrentGeneration`、`nextGeneration`、`孤立 USER`、`连续 USER`、`executionClaims`、`handleRetryExecution`、`WAITING_WS`、`next_retry_at`、`10_000`、`resolveWebSocket`、`context_before`、`globToFileRe`、`McpToolAdapter`、`nameToId`、`getOrCreate`、`sendRaw` 等）。
- 明确排除的既有记录：`logic-bugs-full-scan-20260830.md`（M-4 handleSendMessage claim、L-9、M-5 定时任务 T0 快照等）、`bug-claims-verification-20260831.md`（schedule 侧 withSessionLock 等 6 条，其中 ④⑤ 已在当前工作区修复）、`logic-bugs-review-20260824.md`（BUG-13 resolveWebSocket 覆盖终态、:275 handleCreateSideSession claim、BUG-34 等）、`code_review_20260807234700.md`（delegate 孤立 USER）、`code_review_20260821093505.md:86`（nameToId）、`code_review_20260901073332.md`（今日修复审查，确认 schedule 侧同型锁 bug 已修而微信侧未修）。
- 本报告 5 条 BUG 均未在上述文档中出现；BUG-1/BUG-3 与既有条目为「同根因不同位置」，已在正文标注对照关系。
