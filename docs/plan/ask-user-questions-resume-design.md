# ask_user_questions 断线保留与恢复 — 技术方案设计

> 版本: v1.0 | 日期: 2026-08-05 | 状态: 待评审（已完成决策确认，未改任何代码）

## 1. 需求背景

当前 `ask_user_questions`（Agent 询问用户）工具在调用期间，一旦用户端 WebSocket 断开连接，后端会**立即取消**这次询问：

- `StreamingWsHandler.afterConnectionClosed` / `handleTransportError` 在断开时调用 `askUserQuestionsRegistry.failAllForSessions(subscribedSessionIds)`，把等待中的询问直接置为 `{"error": "Session cancelled"}`；
- Agent 拿到错误结果当作普通工具结果继续执行，询问就此作废；
- 前端问题面板状态 `sessionPendingQuestions` 是 Pinia 内存态，页面刷新即丢失，重连后也无法恢复。

实际使用中，用户可能因网络波动、切后台、刷新页面等原因短暂断开。断开导致询问被取消、必须重新让 Agent 再问一遍，体验割裂且浪费一轮任务。

**目标**：WebSocket 断开不再取消询问；重连（或刷新）后用户能重新看到等待中的问题，并可继续提交回答，Agent 在收到回答后继续执行。

## 2. 需求描述

### 2.1 目标场景

1. **网络断开重连**：Agent 发起询问后，用户端网络短暂断开 → 自动重连成功后，问题面板仍在/恢复显示，用户提交回答，Agent 继续执行。
2. **页面刷新**：询问等待中用户刷新页面 → 重新加载后问题面板恢复显示（含原问题内容），用户可继续提交回答。
3. **超时**：用户一直不回来，询问仍按现有 15 分钟全局超时失败，Agent 拿到错误继续执行，行为与现状一致。
4. **多标签页/多设备**：同账号多个在线连接都会收到恢复的问题，任一连接提交回答即生效（与现有 `ask_user_questions` 推送语义一致）。

### 2.2 非目标场景

- 不解决"后端进程重启后的恢复"（见 5.3 决策 2）。
- 不解决"刷新后对话流中该轮次可见性"（见 5.3 决策 6）。
- 不新增"放弃回答"能力（见 5.3 决策 7）。

## 3. 现状分析

### 3.1 关键代码路径

| 环节 | 位置 | 现状行为 |
|------|------|----------|
| 询问触发与阻塞 | `harness/tool/ToolDispatcher.java:179` `dispatchAskUserQuestions` | 校验在线 → 注册 pending → WS 推送 `ask_user_questions`（含 `requestId`/`questions`/`metadata`）→ 阻塞 `waitForAnswer` |
| 等待注册表 | `harness/tool/AskUserQuestionsRegistry.java` | `sessionId:requestId → CompletableFuture<String>`；15 分钟超时；`register` / `waitForAnswer` / `complete` / `failAllForSession` / `failAllForSessions` |
| **断开即取消** | `session/ws/StreamingWsHandler.java:360`（`afterConnectionClosed`）、`:374`（`handleTransportError`） | `askUserQuestionsRegistry.failAllForSessions(subscribedSessionIds)` —— 本次要移除的调用 |
| 会话级取消（保留） | `StreamingWsHandler.java:122`（`releaseSessionExecutionResources`）、`:172`（`abortRunningExecution`）、`:220`（`abortSubagentChildren`） | `failAllForSession` —— 用户主动取消/打断时仍取消询问 |
| 重连订阅 | `StreamingWsHandler.java:373-392` `handleSubscribe` | 会话 active 时仅推送 `session_snapshot`（只含 phase），**不携带 pending 询问** |
| 前端事件接收 | `desktop/src/composables/useStreamWS.ts:731` | `case 'ask_user_questions'` → `clearAskQuestions` + `appendAskQuestion`（已有 requestId 去重） |
| 前端面板状态 | `desktop/src/stores/session.ts:1025-1044` | `sessionPendingQuestions` 内存态；断线不清、刷新必清、会话终结/新询问/异常 reset 时清 |
| 前端提交回答 | `desktop/src/composables/useChat.ts:957` `submitQuestionAnswer` | WS 发 `ask_user_questions_result`（走 `sendReliable`，断线自动重连重发）→ 后端 `complete` |
| 消息持久化时机 | `harness/core/AgentLoop.java:368` | assistant 消息（含 tool_calls）在 `executeToolCalls` **返回后**才保存；阻塞等待期间该轮次未入库 |

### 3.2 与 LOCAL 工具审批的差异（用户关心的参照物）

LOCAL 工具审批卡片（`tool_execute` → Electron IPC 原生弹窗）在断线期间**一直显示**，是因为它是 Electron 本地 modal，不经 WS 存活；后端其实也在断线时 `LocalToolSessionRegistry.failAllForUser` 将其作废，只是 Electron 端不感知。因此"重连后重新看到"并非后端重推。

`ask_user_questions` 是纯 Web WS 事件驱动：断线 + 刷新后前端内存态丢失，**必须由后端在重连时重新推送事件**才能恢复面板。本方案即以此为核心。

## 4. 总体方案

### 4.1 目标行为

```
Agent 调用 ask_user_questions
    │
    ▼
ToolDispatcher.dispatchAskUserQuestions()
    │  ① 注册 pending（requestId + questions + metadata 存入 AskUserQuestionsRegistry）
    ▼
WS 推送 ask_user_questions 事件 → 客户端面板显示
    │
    ├── [用户提交回答] ──► complete() ──► Agent 继续执行
    │
    ├── [WS 断开] ──► 不再 fail；Agent 继续阻塞等待（最长 15 分钟）
    │        │
    │        ▼
    │    [重连 → 前端重新 subscribe]
    │        │
    │        ▼
    │    handleSubscribe：检测到该会话存在 pending 询问
    │        │
    │        ▼
    │    重新推送 ask_user_questions 事件（复用原 requestId + questions）
    │        │
    │        ▼
    │    前端现有逻辑恢复面板 → 用户可继续提交
    │
    └── [15 分钟超时] ──► 返回 error 给 Agent + 推送 ask_user_questions_cancelled（现状保留）
```

### 4.2 设计要点

- **存储**：后端内存，`AskUserQuestionsRegistry` 的 pending 条目从纯 `CompletableFuture<String>` 扩展为"future + 问题内容"小对象，供重推时取回原问题。
- **恢复通路**：复用现有 `ask_user_questions` 事件重推（前端 `case 'ask_user_questions'` + `appendAskQuestion` 已具备去重），前端**零改动**。
- **推送目标**：沿用 `StreamingWsRegistry.send(userId, ...)` 广播该用户所有在线连接（与初次推送一致）。
- **移除范围**：仅移除断开路径（`afterConnectionClosed` / `handleTransportError`）的 `failAllForSessions`；会话级取消路径（`releaseSessionExecutionResources` / `abortRunningExecution` / `abortSubagentChildren`）的 `failAllForSession` **原样保留**。

## 5. 技术选型决策记录

以下决策均已经用户逐项确认。

### 5.1 决策树

```
断线后询问的命运
 ├─ D1 断线期 Agent 行为：继续阻塞等待（已确认）← 需求前提
 ├─ D2 状态存储：后端内存（已确认）
 ├─ D3 超时策略：保持 15 分钟全局超时（已确认）
 ├─ D4 恢复通路：handleSubscribe 重推 ask_user_questions 事件（已确认）
 ├─ D5 多连接推送：广播所有在线连接（已确认）
 ├─ D6 对话流可见性：不提前持久化（已确认）
 ├─ D7 放弃回答能力：不新增（已确认）
 └─ D8 验收方式：单测 + 手工验证清单（已确认）
```

### 5.2 决策明细

| # | 决策点 | 结论 | 理由 |
|---|--------|------|------|
| D1 | 断线期间 Agent 行为 | **继续阻塞等待** | 保留询问的前提：只有 Agent 还在等，重连后提交才有意义。断开时不再 fail pending |
| D2 | 状态存储位置 | **后端内存**（增强 `AskUserQuestionsRegistry`） | 覆盖页面刷新与 WS 断线两种场景；后端重启时 AgentLoop 执行上下文同样丢失，询问失去执行者，不恢复自洽。不建库表 |
| D3 | 超时策略 | **保持现有 15 分钟全局超时**（`DEFAULT_TIMEOUT_SECONDS = 900`，发起时刻起算） | 实现零改动、行为可预期；断线期间不暂停计时 |
| D4 | 恢复通路 | **handleSubscribe 时重推 `ask_user_questions` 事件**（含原 requestId + questions） | 前端现有 `appendAskQuestion` 复用，已有 requestId 去重；对齐"审批卡片重连后重新看到"的体验（该体验在 ask_user_questions 场景必须由后端重推实现） |
| D5 | 重推推送目标 | **广播该用户所有在线连接**（沿用 `send(userId)` 语义） | 与初次推送一致，零额外改动；多标签页任一连接可提交 |
| D6 | 刷新后对话流可见性 | **不提前持久化**阻塞期间的消息轮次 | 阻塞期间 assistant+tool_calls 轮次未入库是现状设计（避免中断后 DB 残留不完整轮次导致下次 LLM 400）；刷新后仅恢复问题面板，本轮次在用户提交回答后一次性入库 |
| D7 | 放弃回答能力 | **不新增** | 范围聚焦"保留 + 续答"；用户不想回答时可走现有路径：发新消息打断整个执行，或等 15 分钟超时 |
| D8 | 验收方式 | **后端单测 + 手工验证清单** | Playwright E2E 难以模拟 WS 断线，不纳入；单测覆盖 registry 与重推逻辑 |

## 6. 实现步骤

### 6.1 后端（改动 3 个文件）

**① `harness/tool/AskUserQuestionsRegistry.java`**

1. 将 pending 条目从 `CompletableFuture<String>` 扩展为携带问题内容的小对象，例如：

   ```java
   /** sessionId:requestId → pending 询问（future + 原问题内容） */
   private record PendingEntry(
       CompletableFuture<String> future,
       List<Map<String, Object>> questions,   // 原 questions 参数（含选项）
       Map<String, Object> metadata           // 原 metadata 参数（可为 null）
   ) {}
   private final ConcurrentHashMap<String, PendingEntry> pending = new ConcurrentHashMap<>();
   ```

2. 修改 `register` 签名，接收问题内容：`register(Long sessionId, List<Map<String,Object>> questions, Map<String,Object> metadata)`，返回 `requestId`。（`register` 现仅 `ToolDispatcher.dispatchAskUserQuestions` 一处调用，可安全改签名。）

3. 新增查询方法，供重推使用：

   ```java
   /** 返回某会话全部等待中的询问（不含 future），用于重连时重推 */
   public List<AskUserQuestionsRegistry.PendingQuestion> getPendingForSession(Long sessionId)
   ```

   `PendingQuestion` 至少包含 `requestId`、`questions`、`metadata`。

4. `waitForAnswer` / `complete` / `failAllForSession` 语义不变，内部适配新条目结构（超时与失败仍 `future.complete(errorJson)` 并移除条目）；`complete` 改为返回 `boolean` 表示是否实际完成。

**② `harness/tool/ToolDispatcher.java`（`dispatchAskUserQuestions`）**

1. 抽出私有方法 `buildAskUserQuestionsPayload(sessionId, requestId, questions, metadata)`：构造含 `requestId`/`questions`/`metadata` 的 payload（现有解析 arguments 的逻辑迁入）。
2. `register` 时把解析出的 `questions`/`metadata` 一并存入 registry（供重推取回）。
3. 初次推送与超时后的 `ask_user_questions_cancelled` 逻辑保持不变。

**③ `session/ws/StreamingWsHandler.java`**

1. `afterConnectionClosed`（约 :360）：**移除** `askUserQuestionsRegistry.failAllForSessions(subscribedSessionIds)`。
2. `handleTransportError`（约 :374）：**移除** `askUserQuestionsRegistry.failAllForSessions(subscribedSessionIds)`。
3. `handleSubscribe`（约 :373-392）：在现有 `session_snapshot` 逻辑处增加恢复推送：

   ```java
   // 会话 active 且存在等待中的询问时，重推 ask_user_questions 事件（复用原 requestId + questions）
   if (active) {
       List<AskUserQuestionsRegistry.PendingQuestion> pendings =
               askUserQuestionsRegistry.getPendingForSession(sessionId);
       for (AskUserQuestionsRegistry.PendingQuestion p : pendings) {
           registry.send(userId, WsEvent.of("ask_user_questions", sessionId, Map.of(
                   "requestId", p.requestId(),
                   "questions", p.questions() != null ? p.questions() : List.of(),
                   "metadata", p.metadata() != null ? p.metadata() : Map.of()
           )));
       }
   }
   ```

   > 说明：`handleSubscribe` 每次连接建立/重连都会执行；广播语义（D5）由 `registry.send(userId, ...)` 保证，多连接重复接收由前端 requestId 去重兜底。

4. `AskUserQuestionsRegistry.complete()` 改为返回 `boolean`（是否实际完成了一个 pending）；`handleAskUserQuestionsResult` 在返回 true 时向用户广播 `ask_user_questions_cancelled`（含 requestId）。作用：
   - 关闭重连重推竞态下可能恢复出的**失效面板**（另一标签页先提交答案、本标签页重连仍收到旧快照时，取消事件随后到达关闭面板）；
   - 顺带解决"多标签页提交后其它标签页面板不消失"的历史问题（前端已有 `ask_user_questions_cancelled` → `removeAskQuestion` 处理，零前端改动）。
5. 会话级取消路径（`releaseSessionExecutionResources` / `abortRunningExecution` / `abortSubagentChildren`）中的 `failAllForSession` **不改动**。

### 6.2 前端

**零代码改动。** 仅验证以下既有行为：

- `useStreamWS.ts:731` `case 'ask_user_questions'` 接收重推事件 → `appendAskQuestion` 恢复面板（requestId 去重已有）。
- 断线 `onclose` 只触发重连，不清理 `sessionPendingQuestions`（已有行为）。
- 会话终结 / 新询问 / 异常 reset 时 `clearAskQuestions`（已有行为，保持）。
- 提交走 `submitQuestionAnswer` → `sendAskUserQuestionsResult`（`sendReliable` 断线自动重发，已有行为）。

### 6.3 测试

新增后端单测 `backend/src/test/java/cn/etarch/mao/harness/tool/AskUserQuestionsRegistryTest.java`（用例见第 8 节）。

### 6.4 文档

- 更新根目录 `CHANGELOG.md` 当前版本的 `### 后端` 小节：记录"WebSocket 断开不再取消 `ask_user_questions`，重连/刷新后可恢复问题面板并继续提交"。

## 7. 落地清单

### 7.1 要做

| # | 事项 | 归属 |
|---|------|------|
| 1 | `AskUserQuestionsRegistry`：pending 条目扩展为携带问题内容；`register` 接收问题内容；新增 `getPendingForSession` | 后端 |
| 2 | `ToolDispatcher.dispatchAskUserQuestions`：抽出 payload 构造；注册时保存问题内容 | 后端 |
| 3 | `StreamingWsHandler`：断开两处移除 `failAllForSessions`；`handleSubscribe` 增加 pending 重推；`handleAskUserQuestionsResult` 完成时广播 `ask_user_questions_cancelled` | 后端 |
| 4 | 会话级取消路径的 `failAllForSession` 原样保留 | 后端 |
| 5 | 前端零改动，按 6.2 逐项验证 | 前端 |
| 6 | 新增 `AskUserQuestionsRegistryTest` 单测（8.1） | 测试 |
| 7 | 更新根 `CHANGELOG.md` `### 后端` | 文档 |
| 8 | 按 8.2 手工验证清单验收 | 验收 |

### 7.2 明确不做

| # | 事项 | 原因 |
|---|------|------|
| 1 | 数据库持久化 pending 询问 | 后端重启时 Agent 执行上下文一并丢失，恢复无执行者；内存方案已覆盖页面刷新与 WS 断线 |
| 2 | 后端进程重启后的询问恢复 | 见上；Agent 生命周期不跨重启 |
| 3 | `AgentLoop` / `ToolDispatcher` 路由逻辑改造 | 错误结果仍按普通工具结果处理，无需改动 |
| 4 | 阻塞期间提前持久化 assistant+tool_calls 轮次 | 与"中断时不落不完整轮次"设计冲突，可能引发 LLM 400；刷新后仅恢复面板 |
| 5 | 新增"放弃回答"按钮与对应 WS 协议 | 用户可用现有路径（发新消息打断 / 等超时）；范围外 |
| 6 | LOCAL 工具审批（`LocalToolSessionRegistry`）改动 | 审批卡片依赖 Electron 本地 modal，与 Web WS 场景不同；其断线 `failAllForUser` 保持现状 |
| 7 | `session_snapshot` 事件格式变更 | 采用独立重推 `ask_user_questions` 事件，职责清晰 |
| 8 | 多连接定向发送（仅推新连接） | 与现有 `send` 广播语义不一致，且无必要性 |
| 9 | 断线期间暂停超时计时 | 复杂度高、收益低，保持 15 分钟全局超时 |
| 10 | Playwright E2E 用例 | 无法可靠模拟 WS 断线；用单测 + 手工清单替代 |

## 8. 验收方案

### 8.1 后端单测（`AskUserQuestionsRegistryTest`）

| # | 用例 | 断言 |
|---|------|------|
| 1 | register 后 `getPendingForSession` 可见 | 返回条目含 requestId、questions、metadata |
| 2 | 等待期间（未 complete）pending 仍可见 | `getPendingForSession` 不为空，且 `waitForAnswer` 未返回 |
| 3 | complete 后条目移除 | `getPendingForSession` 不再包含该 requestId，future 完成用户结果 |
| 4 | failAllForSession 后条目清空 | future 完成 error，`getPendingForSession` 为空 |
| 5 | 超时后条目移除 | 注入/缩短超时后 `waitForAnswer` 返回 error，条目移除 |
| 6 | `handleSubscribe` 重推（如可行，mock `StreamingWsRegistry`） | active 会话存在 pending 时发送 `ask_user_questions` 事件，payload 含原 requestId/questions |

### 8.2 手工验证清单

| # | 场景 | 步骤 | 预期 |
|---|------|------|------|
| 1 | Electron 断网重连 | 任务中 Agent 触发询问 → 断开网络 → 恢复网络自动重连 | 面板不消失（断网期间）→ 重连后仍可提交，Agent 继续执行 |
| 2 | 浏览器刷新 | 询问等待中刷新页面 | 刷新后面板恢复（问题内容一致），提交后 Agent 继续 |
| 3 | 多标签页 | 同账号两个标签页订阅同一会话 → 刷新其中一个 → 任一标签页提交答案 | 两个标签页均显示问题；任一提交即生效，**其余标签页面板随之关闭** |
| 4 | 15 分钟超时 | 询问等待中不做任何操作 | 超时后 Agent 收到 error 继续执行，面板收到 `ask_user_questions_cancelled` 消失 |
| 5 | 会话取消仍生效 | 询问等待中发新消息打断 | 询问立即失败（`failAllForSession` 保留），执行被 abort，面板消失 |
| 6 | 后端重启边界 | 询问等待中重启后端 | pending 丢失、执行中断（已知边界，行为可接受，记录于第 9 节） |

## 9. 风险与边界

| # | 项 | 说明 |
|---|----|------|
| 1 | 断线期间 Agent 线程阻塞 | 最长阻塞 15 分钟（现状一致），期间占用一个 Agent 执行线程 |
| 2 | 后端重启丢失 pending | 内存存储的固有边界；与 Agent 执行生命周期自洽，接受 |
| 3 | 刷新后对话流该轮次不可见 | 不提前持久化的固有边界；用户提交回答后本轮次一次性入库 |
| 4 | 多标签页提交后其它标签页面板不同步 | 已解决：`handleAskUserQuestionsResult` 完成时广播 `ask_user_questions_cancelled`（含 requestId），所有在线连接关闭面板 |
| 5 | 极端多连接下重复事件 | 前端 `appendAskQuestion` 按 requestId 去重，无副作用 |
| 6 | 超时语义 | 断线期间计时不暂停，等待总时长仍为 15 分钟（发起时刻起算） |
