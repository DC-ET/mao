# 代码审查报告：潜在 Bug / 逻辑错误

- **审查日期**：2026-07-24
- **仓库路径**：`/root/soft/mao/data/workspace/2/projects/mao`
- **审查范围**：后端 harness 核心循环与工具执行（CLOUD/LOCAL）、WebSocket 流式通信与会话状态、认证/权限、会话压缩相关路径、Delegate/Subagent、Skill 同步、桌面端 Electron 本地工具与审批、桌面端 composables（`useStreamWS` / `useChat`）、管理后台权限路由对照。本次**仅审查、未修复**。
- **审查方法**：分模块阅读关键源码（`Grep` / `Read` / 交叉对照 REST 与 WS、CLOUD 与 LOCAL、父会话与子会话路径），以可定位的代码逻辑作为证据；排除纯风格与无证据猜测。

## 严重程度定义

| 级别 | 含义 |
|------|------|
| **Critical** | 可导致未授权访问、身份伪造或跨用户数据操纵，安全影响直接 |
| **High** | 明确逻辑错误，易在正常使用中触发，导致费用失控、取消失效、工具结果错误、审批绕过等 |
| **Medium** | 特定条件下可复现，导致状态不一致、结果污染或同步失败 |
| **Low** | 边界/文档与实现偏差，影响面较小或需较苛刻前置条件 |

---

### BUG-01: WebSocket JWT 未校验签名与过期

- **模块**：认证 / WebSocket
- **严重程度**：Critical
- **位置**：
  - `backend/src/main/java/cn/etarch/mao/session/ws/StreamingWsHandler.java` — `parseUserIdFromToken()` 约 L1358–1372；`resolveUserId()` / `afterConnectionEstablished()` 约 L1287–1289、L230–238
  - 对照：`backend/src/main/java/cn/etarch/mao/auth/service/JwtService.java` — `validateToken()` L70–80；`backend/src/main/java/cn/etarch/mao/config/SecurityConfig.java` — `/ws/**` `permitAll()` 约 L40
- **现象/复现条件**：构造任意 Base64URL JSON payload（含 `"sub":"<目标用户ID>"`），拼成 `x.<payload>.y` 形式伪 JWT，连接 `ws://.../api/ws/stream?token=<forged>&client=browser`。
- **问题分析**：REST 经 `JwtAuthenticationFilter` → `JwtService.validateToken()` 做签名与过期校验；WS 握手仅 `split` + Base64 解码 payload 取 `sub`，**不验签、不查过期**。同时 `/ws/**` 对 Spring Security 放行，鉴权完全依赖该解析函数。
- **潜在影响**：攻击者可冒充任意 `userId` 建立 WS，进一步操控会话流（与 BUG-02 叠加时危害更大）。
- **建议修复方向**：握手阶段统一调用 `JwtService.validateToken()` / 解析 claims；无效或过期 token 关闭连接。

---

### BUG-02: WebSocket 会话操作缺少所有者校验（IDOR）

- **模块**：认证 / 权限 / WebSocket 会话状态
- **严重程度**：Critical
- **位置**：
  - `StreamingWsHandler.java` — `handleSendMessage()` 约 L366–372；`handleCancel()` 约 L1068–1075；`handleEnqueueMessage()` 约 L1080–1092；`handleToolResult()` / `handleToolError()` 约 L822–837
  - 对照：`SessionController.requireSessionOwner()` 约 L330–336
  - `MessageQueueService.enqueue()` 约 L23–41（仅写入 `sessionId`/`userId`，不校验会话归属）
- **现象/复现条件**：攻击者持有合法（或伪造，见 BUG-01）WS 连接，获知他人 `sessionId` 后发送 `send_message` / `cancel` / `enqueue_message` / `tool_result` 等。
- **问题分析**：REST API 普遍调用 `requireSessionOwner` 比较 `session.userId` 与当前用户；WS 多数 handler 仅 `getSession(sessionId)` 确认存在，**不比较所有者**。`handleToolResult` 甚至未使用 `userId` 参数。
- **潜在影响**：向他人会话注入消息、取消任务、入队、伪造 LOCAL 工具结果，操纵 Agent 行为与数据。
- **建议修复方向**：所有带 `sessionId` 的 WS handler 在业务前调用与 REST 等价的所有权校验；`tool_result` 还需确认 `requestId` 属于该会话 pending 集合。

---

### BUG-03: `maxRounds` 已配置但 Agent 循环从未生效

- **模块**：后端 harness 核心循环
- **严重程度**：High
- **位置**：
  - `backend/src/main/java/cn/etarch/mao/harness/core/AgentLoop.java` — `execute()` `while (true)` 约 L96–108（仅检查 cancel，无 round 上限）
  - `AgentExecutionContext.hasNextRound()` 约 L151–153（全仓库无生产调用）
  - `HarnessService.buildContext()` 约 L178：`context.setMaxRounds(resolveMaxRounds(null))`
  - `DelegateTool.buildSubContext()` 约 L307–310：子 Agent 设置 `maxRounds` 同样无效
- **现象/复现条件**：主 Agent 或 `delegate` 子 Agent 持续产生 tool calls（LLM 每轮都调工具）。
- **问题分析**：上下文写入了 `maxRounds`，`hasNextRound()` 已实现，但 `AgentLoop` 主循环从不调用；子 Agent 注释期望 `maxRounds=100` 也无法截断 runaway loop。
- **潜在影响**：无限 tool loop → Token/费用失控；子 Agent 无法按配置止损。
- **建议修复方向**：在每轮开始检查 `!context.hasNextRound()` 并安全退出（注入终止说明或返回明确错误）；`buildContext` 从 Agent 配置读取真实上限。

---

### BUG-04: LOCAL 并行工具超时会失败同会话全部 pending

- **模块**：后端 harness / LOCAL 工具执行
- **严重程度**：High
- **位置**：
  - `backend/src/main/java/cn/etarch/mao/harness/local/LocalToolExecutor.java` — `execute()` catch `TimeoutException` 约 L48–52：调用 `failAllForSession`
  - `LocalToolSessionRegistry.failAllPending()`（由 `failAllForSession` 触发）清掉该 session 全部 futures
  - `AgentLoop.executeToolCalls()` 并行分支约 L357–365：同会话多工具 `runAsync` 并行 dispatch
- **现象/复现条件**：LOCAL 模式下 LLM 一次返回多个工具调用；其中一个超过本地超时（默认约 900s）或触发会话级 fail。
- **问题分析**：并行工具共享 `sessionId` 下的 pending map；**单个**超时调用 `failAllForSession`，把同批其他仍在执行或即将完成的工具全部 complete 为错误。这与并行 dispatch 设计直接冲突。
- **潜在影响**：成功工具结果被错误标记失败；LLM 基于错误 tool result 重复执行或误判。
- **建议修复方向**：超时仅 complete 对应 `requestId`；`failAllForSession` 保留给用户取消/断连等会话级 abort；或 LOCAL 禁止并行。

---

### BUG-05: 父会话取消无法中断 `delegate` 子 Agent

- **模块**：Delegate / Subagent / WebSocket 取消
- **严重程度**：High
- **位置**：
  - `backend/src/main/java/cn/etarch/mao/harness/tool/impl/DelegateTool.java` — `execute()` 约 L204–215：在父工具线程内同步 `agentLoop.execute(subContext, ...)`
  - `AgentLoop.execute()` 约 L102–108：仅读取 `cancelFlags.get(context.getSessionId())`（子会话 ID）
  - `StreamingWsHandler.abortRunningExecution()` 约 L149–166：仅对**父** `sessionId` 设 flag / `failAllForSession`
- **现象/复现条件**：主 Agent 调用 `delegate`；子 Agent 多轮 LLM +（可选）LOCAL 工具执行中，用户点击停止。
- **问题分析**：子 context 使用 `childSession.getId()`，父 cancel flag 对子 loop 不可见；abort 也不 fail 子会话 LOCAL pending。父线程阻塞在 `delegate` 内，直到子跑完才回到父循环检查 cancel。
- **潜在影响**：取消 UX 失效；子 Agent 继续耗 Token、继续 LOCAL 写操作。
- **建议修复方向**：子 loop 继承父 cancel（或 abort 时联动 child SUBAGENT session）；`failAllForSession` 覆盖子会话；或将 delegate 改为可取消异步。

---

### BUG-06: 持久 Shell 会话复用绕过工具审批

- **模块**：桌面端 Electron 本地工具 / 审批流
- **严重程度**：High
- **位置**：`desktop/electron/main.cjs` — `handleShellFromWebSocket()`：复用已有会话分支约 L1467–1485；`write_stdin` 路径约 L1447–1464；新会话审批约 L1488–1494
- **现象/复现条件**：首次 `shell` 带 `needApproval=true` 获用户批准并创建持久 `session_id`；后续同 `session_id` 的 `command` 或 `write_stdin`。
- **问题分析**：`needApproval` 检查仅在「新会话或一次性执行」分支；复用 `shellSessions` 中已有进程时直接 `stdin.write(command)`，**不再审批**。
- **潜在影响**：一次批准后，Agent 可在同一 bash 会话执行任意后续命令（含危险操作），违背审批策略。
- **建议修复方向**：每次 `command`/`write_stdin` 均按 `needApproval`（及危险级别）审批；或显著限制持久 shell 能力并在产品层明确说明。

---

### BUG-07: Skill 同步完成信号在 WS 重连时丢失

- **模块**：Skill 同步 / 桌面端 WebSocket
- **严重程度**：High
- **位置**：
  - `desktop/src/composables/useStreamWS.ts` — `onSkillSyncComplete` 约 L103–113：仅当 `ws.readyState === OPEN` 才发送 `skill_sync_done`，否则 warn 丢弃
  - 后端 `StreamingWsHandler` skill sync 等待（`pendingSkillSyncs`，约 60s 超时）依赖该回执
- **现象/复现条件**：LOCAL 任务触发 `skill_sync_required` → Electron main 下载解压期间 WS 断线重连 → main 完成后发 IPC，renderer 发现 WS 未 OPEN。
- **问题分析**：完成回执是一次性、无重试队列；重连后不会 flush pending `skill_sync_done`，服务端一直等到超时失败。
- **潜在影响**：网络抖动下 LOCAL 任务间歇性 FAILED，用户需手动重试。
- **建议修复方向**：renderer 侧 pending 队列，在 `onopen` flush；或 main 重试；或改 REST 回调完成同步。

---

### BUG-08: 后台任务结果跨会话串扰

- **模块**：后端 harness / Shell 异步工具
- **严重程度**：High
- **位置**：
  - `backend/src/main/java/cn/etarch/mao/harness/core/BackgroundTaskManager.java` — 全局 `@Component` Map；`consumeCompletedResults()` 约 L45–74 消费**全部**已完成任务
  - `AgentLoop.execute()` 约 L110–118：每轮无差别注入 `<后台任务结果>`
  - `ShellSessionTool` 约 L201–208：`async=true` 时 `backgroundTaskManager.submit(...)`
- **现象/复现条件**：会话 A 提交 async shell；会话 B（或其他 AgentLoop）下一轮先执行并调用 `consumeCompletedResults()`。
- **问题分析**：Manager 为进程级单例且无 `sessionId` 维度；任一 AgentLoop 会摘走所有已完成结果注入自己的上下文。
- **潜在影响**：A 的命令输出进入 B 的 prompt，造成错误推理、信息泄露（跨会话上下文污染）。
- **建议修复方向**：按 `sessionId`（或 conversationId）分区存储与消费；`consumeCompletedResults(sessionId)`。

---

### BUG-09: SubAgent 结果收集器跨轮次累积文本

- **模块**：Delegate / Subagent
- **严重程度**：Medium
- **位置**：`backend/src/main/java/cn/etarch/mao/harness/delegate/SubAgentResultCollector.java` — 类注释 L9–11；`onContentDelta` L31–34；`getResult()` L66–68；由 `DelegateTool` L221–225 作为工具返回值
- **现象/复现条件**：子 Agent ≥2 轮：第 1 轮输出过程文本并调工具，第 2 轮输出最终结论。
- **问题分析**：注释写「只保留最后一个 assistant 消息」，但 `contentBuilder` **从不 reset**，`getResult()` 返回全部轮次拼接。
- **潜在影响**：主 Agent 收到含中间过程噪声的结果，可能重复工具调用或误判任务完成；子会话持久化的 ASSISTANT 消息也被污染。
- **建议修复方向**：新 assistant 轮开始（或 `onToolCallStart` / 新 LLM 调用前）清空 builder；仅保留最后一轮无 tool_calls 的 content。

---

### BUG-10: 重连 snapshot 遗漏 `WAITING_APPROVAL`，取消后仍可能应用旧流

- **模块**：WebSocket 会话状态 / 桌面端 composables
- **严重程度**：Medium
- **位置**：
  1. `StreamingWsHandler.handleSubscribe()` 约 L316–329：仅 `RUNNING`/`RESUMING` 发 `session_snapshot`；同文件 `isSessionActive()` L116–118 已包含 `WAITING_APPROVAL`
  2. `desktop/src/composables/useStreamWS.ts` — `isStaleExecution()` L57–66；`clearActiveExecution()` L49–55
  3. `desktop/src/composables/useChat.ts` — `stopExecution()` L633–638：先 `clearActiveExecution` 再 `wsCancel`
- **现象/复现条件**：
  - （A）LOCAL 任务处于 `WAITING_APPROVAL` 时 WS 重连并 `subscribe`；
  - （B）在收到带 `executionId` 的 `session_status` 之前点击停止，随后仍有无 `executionId` 的 `content_delta`。
- **问题分析**：
  - （A）snapshot 条件比 `isSessionActive` 更窄，审批中重连后前端 phase 可能仍为 IDLE/COMPLETED，审批 UI 与后端脱节。
  - （B）若取消时尚无 active executionId，则不会写入 `cancelledExecutionIds`；`isStaleExecution` 在无 active 且无 cancelled 匹配时返回 `false`，旧流继续写入 UI。
- **潜在影响**：重连后看不到待审批；取消后 UI 仍追加已取消 execution 的文本/工具事件，状态不一致。
- **建议修复方向**：snapshot 条件与 `isSessionActive()` 对齐；取消时设置 session 级 generation gate，丢弃该 session 在下次 RUNNING 前的全部 stream 事件。

---

### BUG-11（补充）: Skill mtime 变更检测不递归

- **模块**：Skill 加载与同步
- **严重程度**：Medium
- **位置**：`backend/src/main/java/cn/etarch/mao/harness/skill/SkillSyncService.java` — `getLastModified()` 约 L289–301；同步跳过判断约 L86–92
- **现象/复现条件**：Skill 目录为 `{name}/SKILL.md` + `{name}/scripts/helper.py`；仅修改嵌套脚本，顶层文件 mtime 不变。
- **问题分析**：`getLastModified` 只用 `DirectoryStream` 扫**直接子项**，不递归；嵌套文件变更时 `lastSynced >= sourceModified` 仍成立而 skip。
- **潜在影响**：CLOUD runtime / LOCAL zip 中附属脚本过期，Agent 读到旧资源，行为与源目录不一致。
- **建议修复方向**：`Files.walkFileTree` 取 max mtime，或使用内容 hash / manifest。

---

## 按严重程度汇总

| ID | 标题 | 严重程度 |
|----|------|----------|
| BUG-01 | WebSocket JWT 未校验签名与过期 | Critical |
| BUG-02 | WebSocket 会话操作缺少所有者校验（IDOR） | Critical |
| BUG-03 | `maxRounds` 已配置但从未生效 | High |
| BUG-04 | LOCAL 并行工具超时失败全部 pending | High |
| BUG-05 | 父会话取消无法中断 delegate 子 Agent | High |
| BUG-06 | 持久 Shell 复用绕过审批 | High |
| BUG-07 | Skill sync 完成信号在 WS 重连时丢失 | High |
| BUG-08 | 后台任务结果跨会话串扰 | High |
| BUG-09 | SubAgent 结果跨轮次累积 | Medium |
| BUG-10 | 重连 snapshot / 取消后旧流污染 | Medium |
| BUG-11 | Skill mtime 不递归导致漏同步 | Medium |

**计数**：Critical 2、High 6、Medium 3（共 11 项）。

## 按模块分布

| 模块 | 相关问题 |
|------|----------|
| 认证 / 权限 / 拦截器对照 | BUG-01、BUG-02（REST 有所有者校验、WS 缺失） |
| WebSocket 流式与会话状态 | BUG-01、BUG-02、BUG-07、BUG-10 |
| harness 核心循环与工具（CLOUD/LOCAL） | BUG-03、BUG-04、BUG-08 |
| Delegate / Subagent | BUG-05、BUG-09（及 BUG-03 对子 Agent 的影响） |
| Skill 加载与同步 | BUG-07、BUG-11 |
| 桌面端 Electron 审批 / 本地执行 | BUG-06 |
| 桌面端 composables（useStreamWS / useChat） | BUG-07、BUG-10 |
| 管理后台 | 路由 `meta.permission` 与后端 `@RequirePermission` 对照未见独立可复现绕过；安全问题集中在 WS 通道，后台仍依赖 REST JWT |
| 数据库迁移 / 实体映射 | 本次未发现与上述同级的明确不一致缺陷 |

## 说明

- 本次**仅审查、未修复**任何业务代码；文档为唯一交付物。
- 问题均需人工复审与测试确认后再排期修复；建议优先处理 **BUG-01 / BUG-02**（安全），其次 **BUG-03 / BUG-04 / BUG-05 / BUG-06 / BUG-08**（正确性与费用/审批）。
- 仓库处于初版阶段，审查不以向后兼容为约束。
