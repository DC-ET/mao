# 子智能体执行过程可见性 — 技术方案

> 状态：开发中（后端底座 + 桌面 Tab/流式/列表已落地，待联调验收）  
> 日期：2026-07-24  
> 范围：桌面端（desktop）+ 后端流式/持久化改造  
> 关联：[`subagent-integration-design.md`](../best-agent-spec/subagent-integration-design.md)、[`side-task.md`](./side-task.md)

---

## 1. 需求背景

主 Agent 可通过内置工具 `delegate` 将子任务委派给 `SUBAGENT` 子会话执行。当前实现为：

1. 创建 `session_type=SUBAGENT` 的子会话；
2. 在父工具线程内**同步**跑 `AgentLoop`；
3. 监听器仅为 `SubAgentResultCollector`（只汇总最终文本）；
4. **不挂** `WsStreamingEventListener`，**不挂** `MessagePersistenceCallback`；
5. 子会话仅落库「初始 USER 任务」+「结束后一条 ASSISTANT 终稿」。

因此桌面端只能看到主会话里一张「委派子代理」工具卡片及其最终 JSON 结果，**看不到子智能体执行过程中的文本增量、工具调用与中间轮次**。这与边路任务（Side Task）已具备的「独立 Tab + 实时流式」体验形成明显落差，影响用户对长耗时委派的信任与排障能力。

产品决策（已确认）：

| # | 决策项 | 选择 |
|---|--------|------|
| 1 | 呈现形态 | **复用边路任务式中央 Tab**（只读过程视图） |
| 2 | 实时性 | **必须实时流式**（文本增量、工具起止） |
| 3 | 内容深度 | **完整对话**（assistant 文本、工具调用、工具结果） |
| 4 | 交互 | **纯只读**（不向子智能体发消息；子 Tab 不提供独立取消） |
| 5 | 覆盖端 | **仅桌面端** |

---

## 2. 需求描述

### 2.1 要做的

1. **子智能体启动即对用户可见**：`delegate` 创建子会话后，桌面端自动打开一个中央 Tab，标题体现任务摘要/子代理类型，可实时看到执行过程。
2. **实时流式**：子会话的 `content_delta`、`thinking_*`、`tool_call_*`、`session_status`、`file_change` 等与主会话同构事件，按 `childSessionId` 推送到已连接的桌面端，并写入对应 session 的消息缓存。
3. **完整过程落库**：子 Agent 中间轮次的 ASSISTANT / TOOL 消息写入 `message` 表，刷新或晚打开 Tab 时可通过 `GET /sessions/{childId}/messages` 回放。
4. **Tab 体验对齐边路任务**：复用 `useCenterTabs`、消息渲染（`ChatRoundList` 等）、WS `subscribe` 模式；视觉上接近 `SideChatPanel`，但**无输入框、无队列发送、无向子会话追问**。
5. **主会话入口**：`delegate` 工具卡片提供「查看过程」操作，可激活已有子智能体 Tab（避免用户关掉 Tab 后找不到）。
6. **列表与恢复**：提供按父会话查询子智能体列表的 API；切换回父会话或刷新后可从列表/历史入口重新打开只读 Tab。
7. **LOCAL 工具审批可见**：子智能体在 LOCAL 模式下触发的工具审批，在对应子 Tab 激活时应可见可操作（否则会卡死）；这不属于「向子智能体发消息」，是既有执行通道的必要 UI。

### 2.2 不做的

| 项 | 说明 |
|----|------|
| 管理后台 UI | 本期不改 `admin/` |
| 弹窗/抽屉方案 | 不采用独立 Modal 作为主呈现；统一走中央 Tab |
| 与 Side Task 混用会话类型 | 不把 `SUBAGENT` 写成 `SIDE_TASK`，不进 `GET .../side-tasks` |
| 子智能体多轮追问 | 不开放输入区，不向子会话 `send_message` |
| 子 Tab 独立取消按钮 | 用户仍可通过主会话「停止」取消（现有父 cancel 传播）；本期不在子 Tab 增加单独 abort |
| `delegate` 后台异步执行 | 仍保持同步阻塞父工具线程；不实现设计文档 Phase 2 的 `run_in_background` |
| 新建专用 WS 事件族 `subagent_content_delta` 等 | 复用现有事件类型，仅 `sessionId=childSessionId` 区分来源 |
| 改变主 Agent 上下文隔离策略 | 主 Agent 仍只收最终 tool_result 摘要，不把子过程注入父上下文 |
| 嵌套 delegate 的多层 UI 特化 | 子智能体本身不能再 `delegate`（现有工具过滤已排除）；无需多层 Tab 嵌套设计 |
| 子智能体 Webhook / 独立任务完成通知 | 维持现有策略：`SUBAGENT` 终态不单独发用户通知 |

---

## 3. 现状与缺口

```
主会话 AgentLoop
  └─ tool: delegate
       └─ DelegateTool
            ├─ 创建 SUBAGENT session ✅
            ├─ 写 subagent_execution(RUNNING) ✅
            ├─ saveMessage(USER, task) ✅
            ├─ agentLoop.execute(subContext, SubAgentResultCollector)  ← 仅汇总
            │     ├─ 无 WsStreamingEventListener ❌
            │     └─ 无 MessagePersistenceCallback ❌
            └─ 返回 JSON(tool_result) 给主 Agent ✅

桌面端
  └─ ToolCallCard「委派子代理」running → success + JSON
       └─ 无 Tab / 无 subscribe(childId) / 无过程 UI ❌
```

边路任务已具备且可复用的能力：

- 中央 Tab（`useCenterTabs` / `CenterTabBar` / `CenterTabContainer`）
- `SideChatPanel` + `ChatRoundList` 消息渲染
- WS `subscribe(sessionId)` + `sessionStore` 按 sessionId 缓存
- `GET /sessions/{id}/messages`、父子 `parent_session_id` 模型
- `side_session_created` → 前端打开/绑定 Tab 的事件模式（本次对标新增 `subagent_session_created`）

---

## 4. 技术选型

### 4.1 方案对比（呈现形态）

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| A. 按钮 + 弹窗 | 实现面小 | 与现有中央工作区割裂；不便并排看文件/主会话 | 不做 |
| B. 边路式中央 Tab | 与 Side Task 心智一致；可复用渲染与订阅 | 需区分只读与可对话 | **采用** |
| C. 主会话内联展开 | 少一个 Tab | 长过程挤占主对话；难复用现有 ChatRoundList 布局 | 不做 |

### 4.2 流式通道选型

| 方案 | 说明 | 结论 |
|------|------|------|
| 复用 `WsStreamingEventListener(childSessionId)` | 事件类型不变，前端已按 `sessionId` 路由到 `sessionStore` | **采用** |
| 新造 `subagent_*` 事件族 | 前后端双份逻辑 | 不做 |
| 仅轮询 DB | 无法满足「必须实时流式」 | 不做（轮询仅作断线补齐的辅助，见下） |

**断线/竞态补齐**：创建子会话后立刻推 `subagent_session_created`，并在服务端对当前用户 **auto-subscribe(childSessionId)**（对齐边路任务创建后的订阅习惯）。Tab 打开时若消息缓存为空，再拉一次 `GET /sessions/{childId}/messages`，避免订阅晚于首包 delta 导致丢字。

### 4.3 结果收集选型

`AgentLoop` 只接受一个 `AgentEventListener`。采用 **组合监听器**：

```
CompositeAgentEventListener
  ├─ WsStreamingEventListener(childSessionId, userId, executionId)  // 推前端
  └─ SubAgentResultCollector                                      // 汇总终稿给父 tool_result
```

另传 `MessagePersistenceCallback`（对齐 `HarnessService.executeSideFirstMessage` 的持久化逻辑，写入 child session）。

终稿策略：

- 过程中由 persistence 落中间 ASSISTANT/TOOL；
- `SubAgentResultCollector.getResult()` 仍作为返回给主 Agent 的摘要文本；
- **删除**当前 DelegateTool 在成功后「再单独 save 一条终稿 ASSISTANT」的逻辑，避免与 loop 内最后一次 `onSaveAssistantMessage` 重复；若 loop 未触发最终 save（异常路径），则按失败分支写一条 ASSISTANT/错误说明。

### 4.4 Tab 类型选型

| 方案 | 结论 |
|------|------|
| 直接复用 `type: 'side_task'` | 易与边路列表、关闭逻辑、发送输入耦合，**不做** |
| 新增 `type: 'subagent'` | 独立关闭/恢复/只读渲染，**采用**；UI 组件可从 `SideChatPanel` 抽出共享消息区或做 `readOnly` 变体 |

### 4.5 列表 API 选型

新增 `GET /api/v1/sessions/{parentId}/subagents`，返回结构可参考 `SideTaskVO`（id、title、phase、createdAt、agentType/task 摘要），**不**扩展 `side-tasks` 接口混返回。

---

## 5. 整体架构

```
┌──────────────────────── Desktop ─────────────────────────────────┐
│  主会话 ChatPanel                                                 │
│    delegate ToolCallCard ──[查看过程]──► activate subagent Tab    │
│                                                                   │
│  CenterTabBar: [聊天] [子代理: 搜索认证…] [边路…] [文件…]         │
│  SubagentChatPanel (只读)                                         │
│    ChatRoundList ← sessionStore.messages[childId]                 │
│    ApprovalStack（仅 LOCAL 审批，无 ChatInput）                    │
└───────────────────────────┬───────────────────────────────────────┘
                            │ WS: subscribe(childId)
                            │ 事件 sessionId=childId
┌───────────────────────────▼───────────────────────────────────────┐
│  StreamingWsHandler / StreamingWsRegistry                         │
│                                                                   │
│  DelegateTool.execute()                                           │
│    1. create SUBAGENT session                                     │
│    2. insert subagent_execution(RUNNING)                          │
│    3. save USER(task)                                             │
│    4. ws: subagent_session_created + auto-subscribe(user, child)  │
│    5. agentLoop.execute(                                          │
│         subContext,                                               │
│         Composite(WsStreaming, ResultCollector),                  │
│         MessagePersistenceCallback(childId))                      │
│    6. update execution + phase；返回 tool_result JSON 给父 Agent   │
└───────────────────────────────────────────────────────────────────┘
```

### 5.1 时序（前台同步 delegate + 可见过程）

```
主 Loop          DelegateTool              子 Loop / WS              Desktop
  │                  │                          │                      │
  │ tool_call_start(delegate) ───────────────────────────────────────►│ 主卡片 running
  │                  │                          │                      │
  │─────────────────►│ create child             │                      │
  │                  │── subagent_session_created ─────────────────────►│ 开 Tab + subscribe
  │                  │── auto-subscribe(child)  │                      │
  │                  │── execute(composite) ───►│                      │
  │                  │                          │ content_delta ───────►│ Tab 流式
  │                  │                          │ tool_call_* ─────────►│
  │                  │                          │ persist ASSISTANT/TOOL│
  │                  │◄── result ───────────────│                      │
  │◄─ tool_result ───│                          │ session_status 终态 ─►│ Tab 结束态
  │                  │                          │                      │
```

---

## 6. 后端设计

### 6.1 `CompositeAgentEventListener`

位置建议：`harness/core/CompositeAgentEventListener.java`（通用，边路/其它场景也可复用）。

- 构造：`List<AgentEventListener>` 或 varargs；
- 每个回调依次转发；单个 listener 抛错需打日志并继续转发（避免拖垮结果收集）。

### 6.2 `DelegateTool` 改造要点

文件：`backend/.../harness/tool/impl/DelegateTool.java`

1. 注入 `StreamingWsRegistry`、以及构建 `WsStreamingEventListener` 所需的依赖（与 `StreamingWsHandler` / `HarnessService` 对齐：`ActivityService`、`SessionActivityHeartbeat`、`SessionTodoMapper`、`SessionService` 等）。为降低构造膨胀，可抽 `SubAgentStreamingFactory` 或在 `HarnessService` 增加 `runSubAgentVisible(...)` 方法，由 Harness 统一组装 listener + persistence（**推荐**：逻辑集中在 `HarnessService`，`DelegateTool` 只负责参数解析、子会话创建、审计表与返回 JSON）。
2. 子会话创建成功后立刻：
   - `registry.subscribe(userId, childSessionId)`；
   - `registry.send(userId, WsEvent.of("subagent_session_created", parentSessionId, { childSessionId, title, agentType, task }))`。  
   注意：`WsEvent` 的 `sessionId` 字段用 **父会话 ID**，便于前端在父会话上下文分发；`childSessionId` 放在 data 内（对齐 `side_session_created` 用父会话 + data.sideSessionId 的模式，实现时以现有 `side_session_created` 载荷为准做对称设计）。
3. `executionId`：为子执行生成独立 UUID，写入 `WsStreamingEventListener`，保证前端 `isStaleExecution` 按子会话维度隔离。
4. `agentLoop.execute(subContext, compositeListener, persistenceCallback)`。
5. 成功路径不再重复 `saveMessage(ASSISTANT, resultText)`；失败/取消路径写清 phase 与 `subagent_execution`。
6. 返回 JSON **继续包含** `child_session_id`，供主会话工具卡片「查看过程」绑定。

### 6.3 消息持久化

复用边路任务 persistence 写法（`HarnessService` 中 side 的 callback）：

- `onSaveAssistantMessage` → child session ASSISTANT（含 toolCallsJson、file changes）；
- `onSaveToolMessage` → child session TOOL。

初始 USER(task) 仍在 execute 前写入（已有）。

### 6.4 REST API

**新增** `GET /api/v1/sessions/{id}/subagents`

- 权限：与 `listSideTasks` 相同（校验父会话归属当前用户）。
- 查询：`session_type=SUBAGENT` 且 `parent_session_id={id}`，按创建时间倒序。
- VO 字段至少：`id`、`title`、`phase`、`createdAt`、`agentType`（可从 title/`subagent_execution` 关联）、`taskDescription`（来自 `subagent_execution.task_description` 更准确）。

实现建议：`SessionService.listSubagentSessions` 已存在（用于 cancel 传播），扩展为返回列表 VO；或 JOIN `subagent_execution` 取 task/status。

**已有且直接使用**：

- `GET /api/v1/sessions/{childId}`（详情）
- `GET /api/v1/sessions/{childId}/messages`（过程回放）

**不改**：会话列表 `GET /sessions` 继续排除 `SUBAGENT`。

### 6.5 权限与安全

- `handleSubscribe`：已有 owner 校验则保持；确保用户只能 subscribe 自己的 child session。
- 消息/详情接口沿用现有 session owner 校验即可（当前不区分 session_type）。

### 6.6 LOCAL 模式

- 继续 `LocalToolSessionRegistry.setUserForSession(childId, userId)`（已有）。
- 子工具 `tool_execute` 的 `sessionId` 仍为 childId；桌面端审批 UI 必须在 **子 Tab 激活** 时展示对应 pending（复用 Side Task 审批按 sessionId 过滤的修法，避免只认 `activeSessionId` 主会话）。

---

## 7. 桌面端设计

### 7.1 类型与 Tab

`desktop/src/types/file-browser.ts`：

```ts
type: 'chat' | 'file' | 'diff' | 'side_task' | 'subagent'
// subagent 时使用 sideSessionId 字段存 childSessionId，或新增 subagentSessionId（二选一，推荐复用 sideSessionId 减少改动面，用 type 区分）
```

`useCenterTabs` 新增：

- `openSubagentTab(childSessionId, title)`
- `updateSubagentTab(...)`（如需改标题）
- `restoreSubagentTabs(list)`（父会话恢复时）
- `closeTab`：unsubscribe(childId)；**不**调用边路专用的 `markSideTaskClosed` 一类逻辑

### 7.2 WS 事件

`useStreamWS.routeEvent` 增加：

```ts
case 'subagent_session_created':
  // data: { childSessionId, title, agentType, task }
  // 1) dispatch window event 或直接调 tabs API
  // 2) subscribe(String(childSessionId))
  // 3) 确保 sessionStore 为 childId 初始化消息缓存
  break
```

流式事件无需新 case：现有 `content_delta` / `tool_call_*` 等已按 `sessionId` 写入 store。

重连：`toResubscribe` 集合需包含所有已打开的 subagent Tab 的 childSessionId（与 side_task 同等对待）。

### 7.3 `SubagentChatPanel`（新建）

位置建议：`desktop/src/components/chat/SubagentChatPanel.vue`

- **复用**：`ChatRoundList`、消息映射、`ApprovalStack`（LOCAL）、可选 thinking/typing 指示。
- **隐藏/禁用**：`ChatInput`、`QueuePanel`、继承上下文勾选、边路首条发送逻辑、`QuestionPanel` 提交（子代理若触发 `ask_user_questions`：见下「风险」）。
- Props：`subagentSessionId`、`parentSessionId`、只读标题区（展示 agentType / task 摘要 / phase）。
- `onMounted`：`subscribe(id)`；若 store 无消息则 `api.get(/sessions/{id}/messages)` 灌入。
- `onUnmounted`：按产品选择是否 `unsubscribe`（建议关闭 Tab 时 unsubscribe，保持与 side 一致）。

`CenterTabContainer`：`v-else-if="activeTab?.type === 'subagent'"` 挂载该面板。

### 7.4 主会话 `delegate` 卡片

- 解析 tool result / args 中的 `child_session_id`（running 阶段若尚未有 result，依赖 `subagent_session_created` 在 store 侧记录 parent→child 映射，或在卡片上监听同一映射）。
- 增加按钮「查看过程」→ `openSubagentTab` / `activateTab`。
- 摘要文案：运行中显示「子代理执行中…」；结束显示成功/失败轮次摘要（可从 result JSON 取 `rounds`/`tool_calls`）。

### 7.5 右侧任务检视（可选但列入本期落地）

在 `TaskInspector` / 边路列表旁增加「子代理」分组，数据来自 `GET .../subagents`，点击打开只读 Tab。  
若工期紧，可把「右侧列表」列为同一需求内的 **P1**，但 API + Tab 自动打开为 **P0**。

建议本期 **P0 包含右侧列表**，与边路任务持久化面板对称，避免只能依赖当时自动打开的 Tab。

---

## 8. 实现步骤

### Phase A — 后端可见性底座（P0）

1. 实现 `CompositeAgentEventListener` + 单测。
2. 在 `HarnessService`（或等价工厂）封装「可见子智能体执行」：组装 WS listener、persistence、result collector。
3. 改造 `DelegateTool`：创建后推送 `subagent_session_created`、auto-subscribe、改用组合执行、修正终稿落库去重。
4. 新增 `GET /sessions/{id}/subagents` + VO + 权限校验 + 单测。
5. `mvn test` 覆盖 Delegate 相关与 WS 事件载荷。

### Phase B — 桌面 Tab 与流式（P0）

1. Tab 类型 `subagent` + `useCenterTabs` API。
2. `useStreamWS` 处理 `subagent_session_created`；重连 resubscribe。
3. 新建 `SubagentChatPanel`（只读）并接入 `CenterTabContainer`。
4. `delegate` 工具卡片「查看过程」。
5. LOCAL 审批按子 sessionId 展示（回归边路同类问题）。

### Phase C — 恢复与列表（P0/P1）

1. 进入父会话时拉 `GET .../subagents`，右侧列表展示；点击恢复 Tab。
2. 打开历史子代理时拉 messages 回放（无实时流）。
3. 手动验证：长任务实时可见、刷新后可回看、主会话停止后子过程停止。

### Phase D — 文档与回归

1. 更新 `docs/technical-design/side-task.md` 对比表中「Delegate 无独立 UI」一行。
2. 桌面端冒烟：CLOUD + LOCAL 各跑一次 `delegate`；并行边路任务不受影响。

---

## 9. 落地清单

### 9.1 后端

| # | 项 | 优先级 |
|---|----|--------|
| B1 | `CompositeAgentEventListener` | P0 |
| B2 | `DelegateTool` / `HarnessService`：WS 流式 + 全量消息持久化 + 创建通知 | P0 |
| B3 | `subagent_session_created` 事件载荷约定 | P0 |
| B4 | 创建后 `registry.subscribe(userId, childId)` | P0 |
| B5 | `GET /sessions/{id}/subagents` | P0 |
| B6 | 单测：组合监听转发、列表 API、Delegate 落库轮次 | P0 |
| B7 | 去除成功路径重复 ASSISTANT 终稿 | P0 |

### 9.2 桌面端

| # | 项 | 优先级 |
|---|----|--------|
| D1 | Tab `subagent` + open/activate/close/unsubscribe | P0 |
| D2 | `subagent_session_created` → 自动开 Tab + subscribe | P0 |
| D3 | `SubagentChatPanel` 只读完整对话渲染 | P0 |
| D4 | 打开 Tab 时 messages 补齐 | P0 |
| D5 | `delegate` 卡片「查看过程」 | P0 |
| D6 | 重连 resubscribe 含 subagent | P0 |
| D7 | LOCAL 子会话审批在子 Tab 可见 | P0 |
| D8 | 右侧「子代理」列表 + 恢复 | P0 |
| D9 | 管理后台 | **不做** |

### 9.3 明确不做（再次冻结）

- 弹窗主方案、admin UI、子会话追问、子 Tab 独立取消、delegate 后台模式、`subagent_*` 流式事件族、把 SUBAGENT 并入 side-tasks、向父上下文注入子过程细节。

---

## 10. 风险与对策

| 风险 | 对策 |
|------|------|
| 订阅晚于首包 delta 丢字 | 服务端 auto-subscribe + Tab 打开拉历史 messages |
| 同步 delegate 阻塞父工具线程过久 | 本期接受（不做后台模式）；UI 用 Tab 缓解「无反馈」；后续另立需求做后台 |
| 父会话 `tool_call_start(delegate)` 与 `subagent_session_created` 时序 | 先建会话并通知，再 `execute`；卡片 running 与 Tab 可同时存在 |
| 子代理触发 `ask_user_questions` | 现有定义若允许该工具：只读面板需展示 `QuestionPanel` 并允许提交答案（否则会死锁）。实现前核对 `AgentDefinition` 工具白名单；若白名单含 `ask_user_questions`，则 **只读输入区仍排除，但提问面板必须可答**（记为只读视图的例外，等同 LOCAL 审批） |
| 与 Side Task 关闭/清空逻辑互相误伤 | 独立 `type: 'subagent'`；关闭全部文件等操作不得误关 subagent（对照既有 side_task bug 文档） |
| 消息量与 WS 队列 | 子过程工具输出可能很大；沿用现有截断/摘要策略，不在本期另做专用限流，但需观察 `app.ws.outbound-queue-capacity` |

---

## 11. 验收标准

1. 主 Agent 调用 `delegate` 后，桌面端 **自动出现**子代理 Tab，执行中可见流式文本与工具卡片更新。
2. 子过程中的工具调用与结果在 Tab 中完整展示（与主会话 ChatRoundList 信息等价，只读）。
3. 刷新或关闭再打开后，可通过右侧列表 /「查看过程」重新打开，并看到已落库的完整历史。
4. 主会话停止后，子智能体停止，Tab 进入取消/结束态。
5. LOCAL 模式下子智能体触发需审批工具时，在子 Tab 内可完成审批。
6. 边路任务、主会话原有流式与审批行为无回归。
7. `admin` 无改动；会话列表仍不出现 SUBAGENT 行。

---

## 12. 关键文件（实现时改动面）

**后端**

- `harness/tool/impl/DelegateTool.java`
- `harness/core/HarnessService.java`（建议承载组装）
- `harness/core/CompositeAgentEventListener.java`（新建）
- `harness/delegate/SubAgentResultCollector.java`（可能微调）
- `session/ws/StreamingWsRegistry.java` / `StreamingWsHandler.java`（subscribe 校验如需）
- `session/controller/SessionController.java`（listSubagents）
- `session/service/SessionService.java`

**桌面**

- `types/file-browser.ts`
- `composables/useCenterTabs.ts`
- `composables/useStreamWS.ts`
- `components/chat/SubagentChatPanel.vue`（新建）
- `components/chat/ToolCallCard.vue` / 工具结果展示
- `components/center/CenterTabContainer.vue` / `CenterTabBar.vue`
- `views/task/TaskView.vue`
- `components/task/*`（子代理列表）

---

## 13. 与既有设计文档的关系

- [`subagent-integration-design.md`](../best-agent-spec/subagent-integration-design.md) 中 Phase 2「ForwardingEventListener / 新事件族」与 Phase 3「子任务卡片」：本方案用 **标准事件 + childSessionId + 中央 Tab** 替代，不再实现单独的 `subagent_content_delta` 事件族与弹窗卡片主路径。
- [`side-task.md`](./side-task.md) 对比表中「子智能体无独立 UI」在本需求落地后应更新为「只读中央 Tab，不可追问」。
