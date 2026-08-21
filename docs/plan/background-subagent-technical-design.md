# 后台子代理（主代理异步并行委派）技术方案

> 文档状态：已达成共识，待实施
> 日期：2026-08-16
> 适用范围：`backend-ts/`、`desktop/`（共用 UI）
> 关联能力：现有 `delegate` / `delegate_followup`（同步子代理）、`SIDE_TASK`（用户手动边路任务）、`subagent_execution` 崩溃恢复/结果交付体系

---

## 1. 需求背景

### 1.1 问题

当前主代理触发的子代理是**同步阻塞**的：主代理一旦调用 `delegate` 或 `delegate_followup`，就必须原地等待子代理执行完成，拿到结果后才能继续下一步。这带来两个体验问题：

1. **无法并行**：主代理不能把若干相对独立的分支工作派发出去后继续推进主线，只能串行等待，整体任务耗时长。
2. **主线被阻塞**：子代理运行期间主代理完全空转，无法利用这段时间做主线工作。

项目中已有的 `SIDE_TASK`（边路任务）虽然具备「后台并行、可查看进度、可取消」的能力，但只能由**用户在前端手动创建**，主代理无法主动调用，因此不能直接满足「主代理主动派发后台工作」的需求。

### 1.2 目标

让主代理能够**主动发起后台子代理**，实现：

- 主代理派发子代理后**立即返回**，继续执行主线工作；
- 主代理可**主动查看**后台子代理的执行进度；
- 后台子代理**完成时主动汇报结果**（无需主代理轮询）；
- 当还存在后台子代理未结束时，主代理**不能完结**，需挂起等待全部后台子代理结束；
- 主代理可**主动取消**后台子代理；
- 复用现有 SUBAGENT 会话、`subagent_execution`、崩溃恢复、结果交付与前端子代理 Tab 基础设施。

### 1.3 边界说明（要做 / 不做）

| 要做的 | 不做的 |
|---|---|
| 新增「后台子代理」工具族：`spawn_subagent` / `check_subagent` / `cancel_subagent` / `wait_subagents` | 不改变现有 `delegate` / `delegate_followup` 的同步语义 |
| 后台子代理复用 `SUBAGENT` 会话类型与 `subagent_execution` 记录，`invocation_type` 新增 `BACKGROUND` | 不复用 `SIDE_TASK` 作为主代理后台子代理的承载 |
| 主代理派发后立即拿到 `task_id`（执行记录 id）与 `child_session_id`，继续主线 | 不在 `spawn_subagent` 内同步等待子代理完成 |
| 主循环结束时若仍有运行中后台子代理，自动挂起（进入 `WAITING_SUBAGENTS` 相位），全部结束后自动续跑 | 不在主循环内真正阻塞持有 WebSocket 直到子代理结束 |
| 子代理完成时，把结果摘要注入主代理上下文，并在父会话追加可见的「后台子代理完成」卡片 | 不把完成结果构造成第二条同 `tool_call_id` 的 TOOL 消息（与 OpenAI 协议冲突） |
| 主代理可 `check_subagent(task_id)` 查单个、`check_subagent()` 列全部 | 不在 `check` 返回子代理完整消息历史 |
| 主代理可 `cancel_subagent(task_id)` 取消单个；父会话被取消时级联取消全部后台子代理 | 不新增用户在前端手动取消后台子代理的按钮 |
| 后台子代理继承父会话执行模式，CLOUD 与 LOCAL 都支持 | 不做「LOCAL 不支持、自动退化为同步」的降级 |
| 后台子代理的并发数与运行时长不设硬上限、不设超时 | 不因并发或超时自动中断后台子代理 |
| 后台子代理禁止再派生自己的后台子代理（父子关系只有一层） | 不实现多层级嵌套后台子代理与树状等待 |
| 后台子代理接入现有 `subagent_execution` 崩溃恢复体系 | 不做独立于现有恢复体系的新恢复机制 |
| 后台子代理产生的文件变更归集到父任务变更清单 | 不做「只在子代理 Tab 展示、不归集到父任务」 |
| 前端复用现有子代理 Tab 只读展示后台子代理状态，主会话显示完成卡片 | 不新增用户取消按钮、不新增后台子代理专属管理面板 |

---

## 2. 需求描述

### 2.1 用户故事

> 作为主代理，我在处理一个开发任务时，希望把「调研方案 A」「代码审查模块 B」这类相对独立的分支工作派发给后台子代理并行执行，自己继续推进主线。中途我能查看它们跑到哪了，也能在必要时取消某个。当我主线工作做完时，如果还有子代理在跑，我会先挂起等待；等它们全部汇报完成后，我再综合所有结果给出最终结论。

### 2.2 核心交互流程

```text
主代理 loop 运行中
  │
  ├─ spawn_subagent(agent_type, task)
  │     └─ 后台创建 SUBAGENT 子会话 + subagent_execution(BACKGROUND)
  │     └─ 立即返回 { task_id, child_session_id, status: RUNNING }
  │     └─ 主代理继续主线
  │
  ├─ check_subagent(task_id?)        ← 主动查看进度（单查 / 列全部）
  │
  ├─ cancel_subagent(task_id)        ← 主动取消单个后台子代理
  │
  ├─ wait_subagents()                ← 主动等待全部后台子代理结束，返回汇总结果
  │
  ├─ （子代理完成）→ 完成通知写入父会话 + 注入主循环上下文（主动汇报）
  │
  └─ 主循环准备结束
        ├─ 无运行中后台子代理 → 正常输出最终答案，完结
        └─ 仍有运行中后台子代理 → 挂起（WAITING_SUBAGENTS），全部结束后自动续跑
```

### 2.3 四个工具

| 工具 | 入参 | 返回 | 语义 |
|---|---|---|---|
| `spawn_subagent` | `agent_type`、`task` | `{ task_id, child_session_id, status: "RUNNING" }` | 创建后台子代理并立即返回 |
| `check_subagent` | `task_id?` | 单个：进度快照；缺省：当前会话全部后台子代理列表 | 主动查看进度 |
| `cancel_subagent` | `task_id` | `{ cancelled: true, task_id }` | 取消指定后台子代理 |
| `wait_subagents` | 无 | 全部后台子代理的汇总结果 | 阻塞等待全部结束 |

`check_subagent` 单个进度快照字段：`status`（RUNNING/COMPLETED/FAILED/CANCELLED）、`total_rounds`、`total_tool_calls`、`total_prompt_tokens` / `total_completion_tokens`、最近一条 assistant 输出摘要（截断到可控长度，例如 2000 字符）。

### 2.4 状态与相位

- 后台子代理复用 `SUBAGENT` 会话，其 `phase` 状态机沿用现有 `RUNNING` → `COMPLETED` / `FAILED` / `CANCELLED`，崩溃恢复时使用 `RESUMING`。
- 父会话新增非终态相位 `WAITING_SUBAGENTS`，表示「主线已暂停、正在等待后台子代理结束」。对外事件仍保持前端可识别的既有映射（见第 8 节）。

---

## 3. 现状分析

### 3.1 同步 delegate 的执行路径

- `DelegateTool`（`backend-ts/src/harness/tool/impl/delegate-tool.ts`）在 `executeWithSession` 中创建子会话与执行记录后，直接 `await visibilityService.executeVisible(...)` 同步等待子代理跑完，再返回结果。
- `DelegateFollowupTool` 同理，且校验 `childSession.phase === 'RUNNING'` 时拒绝追问。

### 3.2 边路任务（SIDE_TASK）的异步执行路径

- `StreamingWsHandler.handleCreateSideSession`（`backend-ts/src/session/ws/streaming-ws-handler.ts`）由用户 WS 消息触发，创建 `SIDE_TASK` 会话后，通过 `agentExecutor.submit(...)` 在后台执行 `executeSideFirstMessage`。
- 已有 `cancel_side_task`、`runningTasks` / `runningExecutionIds` / `executionClaims` / `cancelFlags` 等后台任务管理能力，可被新能力参考复用，但 SIDE_TASK 与 SUBAGENT 是两个独立 session 类型，不能直接互用。

### 3.3 崩溃恢复与结果交付

- `subagent_execution` 表（V040/V075）已具备 `invocation_type`（`DELEGATE`/`FOLLOWUP`）、`parent_tool_call_id`、`delivery_status`、`parent_assistant_message_id` / `parent_tool_message_id`、`execution_start_message_id`、`final_message_id`、`total_tool_calls` 等字段。
- `SubagentRecoveryCoordinator` + `SubagentExecutionRecoveryService` + `SubagentResultDeliveryService` 已实现「父任务等待全部关联子代理交付后再恢复」的屏障。
- 现有 `SubagentResultDeliveryService.deliver()` 通过「重建 assistant `tool_calls` + TOOL」把同步 delegate 的结果补入父历史，**不适用于后台子代理**（后台 spawn 的 TOOL 结果已同步返回，完成结果需要以通知形式注入）。

### 3.4 可复用点

- `SubAgentVisibilityService`：`notifySubagentCreated`（发 `subagent_session_created`，前端打开子代理 Tab）、`executeVisible` / `executeVisibleWithTimeout`、`finishSubagent`。
- `AgentLoop`：每轮开始已调用 `backgroundTaskManager.consumeCompletedResults()` 注入后台任务结果；循环结束点可插入「后台子代理挂起」判断。
- `AbortSubagentChildren`（`StreamingWsHandler.abortSubagentChildren`）：父会话取消时级联取消 SUBAGENT 子会话。
- `agentExecutor`：`createAgentExecutor` 提供的受控异步执行器，用于真正并行跑后台子代理。

---

## 4. 技术选型

### 4.1 总体方案

新增一套「后台子代理」工具族，复用 `SUBAGENT` 会话 + `subagent_execution` + 现有恢复/交付体系；在 `AgentLoop` 结束点增加自动挂起，在子代理完成时以「完成通知」注入父会话并触发续跑。现有 `delegate` / `delegate_followup` 保持同步语义不变。

### 4.2 关键设计决策

| 决策项 | 结论 |
|---|---|
| 落地形态 | 新增 `spawn_subagent` / `check_subagent` / `cancel_subagent` / `wait_subagents` 工具族 |
| 会话承载 | 复用 `session_type = 'SUBAGENT'`，执行记录 `invocation_type = 'BACKGROUND'` |
| 挂起语义 | 主循环结束点自动拦截 + 显式 `wait_subagents` 工具 |
| 挂起模型 | 暂停本轮（父会话 `WAITING_SUBAGENTS`）+ 全部完成后自动续跑（复用恢复的 resume 机制） |
| 结果汇报 | 完成结果注入主代理上下文 + 父会话追加可见「后台子代理完成」卡片 |
| 取消 | `cancel_subagent(task_id)` 单个取消 + 结果回传 + 父会话取消级联 |
| 前端 | 复用子代理 Tab 只读展示 + 主会话完成卡片；不新增用户取消按钮 |
| 执行模式 | CLOUD 与 LOCAL 都支持，继承父会话执行模式 |
| 并发 / 超时 | 不设硬上限、不设超时（由主代理自行控制） |
| 嵌套 | 禁止后台子代理再派生后台子代理 |
| 崩溃恢复 | 集成现有 `subagent_execution` 恢复体系 |
| 文件归集 | 后台子代理文件变更归集到父任务变更清单 |
| 进度粒度 | 状态 + 轮次 + 用量 + 最近输出摘要 |

### 4.3 数据模型

复用 `subagent_execution`，`invocation_type` 扩展为 `DELEGATE` / `FOLLOWUP` / `BACKGROUND`（`VARCHAR(20)`，无需结构变更，仅更新注释语义）。`parent_tool_call_id` 记录 `spawn_subagent` 的工具调用 id（用于关联与幂等，但不用于重建第二条 TOOL 结果）。`delivery_status` 对 `BACKGROUND` 表示「完成通知是否已交付父会话」。

### 4.4 完成通知的交付形式

后台子代理完成时，不在父会话重建 assistant + TOOL 对，而是：

1. 向父会话持久化一条 `ASSISTANT` 消息，`toolCalls` 为空，`metadata` 携带 `backgroundSubagentCompletion`（含 `child_session_id`、`execution_id`、`status`、结果摘要），`content` 为可读摘要文本。
2. 将该完成结果投递到父会话的「待消费后台结果」队列，供主循环下一轮开始注入上下文（主动汇报）。
3. 若父会话正处于 `WAITING_SUBAGENTS`，则同时触发父会话续跑（见第 5.4 节）。

---

## 5. 核心设计

### 5.1 后台子代理管理器 `BackgroundSubagentManager`

新增服务，持有：

- `pendingByParent: Map<parentSessionId, Set<executionId>>`：每个父会话尚未终态的后台执行；
- `resultsByParent: Map<parentSessionId, Array<{ executionId, resultJson }>>`：已完成、待主循环消费的结果；
- `resumeCallbacks: Map<parentSessionId, () => Promise<void>>`：父会话续跑入口（由调用方注入）。

职责：

- `spawn(parentSession, definition, task, toolCallId)`：事务创建 SUBAGENT 子会话 + `subagent_execution(BACKGROUND)` + 初始 USER，注册 cancel flag，提交 `agentExecutor` 异步执行；
- `onCompleted(executionId, status, resultJson)`：终态落库后，写完成通知、投递结果、必要时触发续跑；
- `consumeResults(parentSessionId)`：供 AgentLoop 每轮开始消费；
- `hasRunning(parentSessionId)`：供 AgentLoop 结束点判断是否挂起；
- `cancel(executionId)`、`list(parentSessionId)`、`snapshot(executionId)`。

### 5.2 `spawn_subagent` 异步执行

1. 校验父会话存在、`agent_type` 合法；
2. 取 `ToolCallContext.getToolCallId()` 作为 `parent_tool_call_id`；
3. 事务创建 child session（`SUBAGENT`）与 execution（`invocation_type=BACKGROUND`、`delivery_status=PENDING`、`status=RUNNING`）；
4. 继承父会话 `executionMode` / `workspace` / `permissionLevel` / `modelId` / `isGit` / `platform` / `shellPath` / `osVersion` / `projectKey`；
5. LOCAL 模式下向 `LocalToolSessionRegistry` 注册 child → user 映射；
6. 通过 `SubAgentVisibilityService.notifySubagentCreated` 发 `subagent_session_created`（前端打开只读子代理 Tab）；
7. 复用 `DelegateTool.buildSubContext` 构建子代理上下文（该函数需扩展：同时排除新后台工具族，防止嵌套）；
8. 注册 child cancel flag，父 cancel 与 child cancel 联动（父取消 → 子取消）；
9. 提交 `agentExecutor.submit(...)` 后台执行 `visibilityService.executeVisible`；
10. 执行完成后按终态调用 `onCompleted`；
11. 工具立即返回 `{ task_id: executionId, child_session_id, status: "RUNNING" }`。

### 5.3 `check_subagent` / `cancel_subagent` / `wait_subagents`

- `check_subagent(task_id?)`：
  - 有 `task_id`：从 `subagent_execution` 读状态、轮次、用量，并取最近一条 assistant 输出做截断摘要；
  - 无 `task_id`：列出当前父会话全部 `BACKGROUND` execution 的状态。
- `cancel_subagent(task_id)`：校验 execution 属于当前父会话且非终态，置子会话 cancel flag，等待其收尾为 `CANCELLED`，回传 `{ cancelled: true }`。
- `wait_subagents()`：阻塞等待当前父会话全部 `BACKGROUND` execution 进入终态，返回汇总结果；等待期间监听父 cancel flag，父取消时提前返回。因用户确认不设超时，该工具不设超时。

### 5.4 主循环挂起与续跑

在 `AgentLoop.execute` 的结束点（`pendingToolCalls` 为空、准备 `break`）之前插入判断：

1. 若 `backgroundSubagentManager.hasRunning(sessionId)` 为 false，正常 `break` 并 `onMessageEnd`；
2. 若存在运行中后台子代理：
   - 不进入终态，调用一个 suspend 回调：父会话 `phase = 'WAITING_SUBAGENTS'`，发送 `session_status`（对外映射为 `RUNNING`，见第 8 节）；
   - 直接 `return`（结束本轮，不 emit 终态 `onMessageEnd`）；
   - 等待所有后台子代理完成时，由 `onCompleted` 触发父会话续跑（复用 `HarnessService.execute` 重建上下文并再次进入 AgentLoop）。

续跑时，父会话历史中已包含所有「后台子代理完成」卡片，模型据此产出最终综合结论。

### 5.5 完成结果注入主循环上下文

`AgentLoop` 每轮开始时，除现有 `backgroundTaskManager.consumeCompletedResults` 外，追加：

```text
backgroundSubagentManager.consumeResults(sessionId)
  → 把已完成后台子代理的结果 JSON 拼成系统消息注入 context
```

这保证主代理在**未结束**时也能在下一轮「主动感知」到已完成的子代理，无需轮询。

### 5.6 崩溃恢复集成

- `SubagentExecutionRecoveryService.recover()` 已能恢复 `RUNNING` / `RECOVERING` 且 `delivery_status=PENDING` 的执行记录；`BACKGROUND` execution 自然进入该扫描，恢复时继续复用 `buildSubContext` 并 `executeVisibleWithTimeout`（无超时决策下，恢复执行不再受 3600s 限制，仍以无超时处理）。
- `SubagentResultDeliveryService.deliver()` 增加 `invocation_type === 'BACKGROUND'` 分支：不重建 assistant + TOOL 对，改为写入「完成通知」卡片并投递结果；`SUPPRESSED` 逻辑复用（父会话已终态则不注入）。
- `SubagentRecoveryCoordinator` 的「父任务等待全部关联子代理交付后再恢复」屏障对 `BACKGROUND` 同样成立：父会话 `WAITING_SUBAGENTS` 或 `RUNNING` 时，全部后台子代理收敛并交付后恢复父会话。

### 5.7 文件变更归集

后台子代理产生的 `message_file_change` 归属其 child session（与现有子代理一致）。归集到父任务时，按「父会话 id + 关联 `BACKGROUND` execution 的 `execution_start_message_id` / `final_message_id`」聚合，追加到主任务变更清单；不绑定到某一条父工具调用（因为完成时机异步）。复用现有 `subagent-file-change-aggregation-fix-plan.md` 的归集服务，扩展支持 `BACKGROUND` invocation。

### 5.8 父会话取消级联

父会话取消时，`abortSubagentChildren` 已级联取消 SUBAGENT 子会话；`BackgroundSubagentManager` 需将未终态的 `BACKGROUND` execution 收尾为 `CANCELLED`，`delivery_status` 置 `SUPPRESSED`（不注入父历史）。

---

## 6. 数据库设计

无需结构变更（复用 V040/V075 已建字段）。仅需：

1. 在 `subagent_execution.invocation_type` 的注释/文档中补充 `BACKGROUND` 取值说明（`VARCHAR(20)` 已容纳）；
2. `session.phase` 新增 `WAITING_SUBAGENTS` 取值（`VARCHAR(20)` 已容纳）；
3. 若后续需要，新增一条迁移更新注释，不改列类型。

若需对「后台完成通知」做前端查询优化，可考虑对 `subagent_execution(invocation_type, delivery_status)` 增加索引，但当前量级下非必须（不做）。

---

## 7. 实现步骤

### 阶段一：领域模型与后台管理器

1. 扩展 `SubagentExecution.invocationType` 类型为 `'DELEGATE' | 'FOLLOWUP' | 'BACKGROUND'`；
2. 新增 `BackgroundSubagentManager` 服务（spawn / onCompleted / consumeResults / hasRunning / cancel / list / snapshot）；
3. 在 `create-app.ts` 装配该服务，注入 `db`、`subagentExecutionMapper`、`sessionMapper`、`visibilityService`、`agentLoop`、`agentExecutor`、`localToolSessionRegistry` 等；
4. 扩展 `DelegateTool.buildSubContext`：子代理工具集排除 `spawn_subagent` / `check_subagent` / `cancel_subagent` / `wait_subagents`（防止嵌套）。

### 阶段二：四个工具实现

1. 新建 `spawn-subagent-tool.ts`：创建后台执行并立即返回 handle；
2. 新建 `check-subagent-tool.ts`：单查/列表 + 进度快照；
3. 新建 `cancel-subagent-tool.ts`：取消指定后台子代理；
4. 新建 `wait-subagents-tool.ts`：阻塞等待全部结束并汇总；
5. 在 `ToolRegistry` / 工具装配处注册四个工具；
6. 工具 description / prompt 明确「何时用、何时不用」，并说明子代理无法与用户交互、禁止嵌套。

### 阶段三：主循环挂起与续跑

1. 在 `AgentLoop.execute` 每轮开始处追加 `BackgroundSubagentManager.consumeResults` 注入；
2. 在循环结束点（无 tool calls 准备 break）前插入 `hasRunning` 判断，存在则 suspend（`WAITING_SUBAGENTS`）并 return；
3. 新增 suspend/resume 回调注入点，续跑复用 `HarnessService.execute`；
4. `BackgroundSubagentManager.onCompleted` 在最后一个子代理完成且父会话 `WAITING_SUBAGENTS` 时触发续跑；
5. 处理父取消时提前退出 `wait_subagents` 与挂起状态。

### 阶段四：崩溃恢复集成

1. `SubagentResultDeliveryService.deliver()` 增加 `BACKGROUND` 分支（写完成通知卡片 + 投递结果）；
2. 恢复扫描把 `BACKGROUND` execution 纳入现有 `listRecoveryCandidates`；
3. 恢复执行沿用 `buildSubContext`，无超时决策下取消 3600s 限制（如需保留安全阀，单独评估，不在本次引入）；
4. `SubagentRecoveryCoordinator` 对 `BACKGROUND` 采用相同的「全部交付后再恢复父会话」屏障；
5. 父取消场景将 `BACKGROUND` execution 收敛为 `CANCELLED` / `SUPPRESSED`。

### 阶段五：文件变更归集

1. 扩展归集服务支持 `invocation_type='BACKGROUND'`，按父会话 + execution 消息边界聚合；
2. 主任务变更清单接口返回后台子代理产生的文件变更；
3. 保持「子代理 Tab 内只展示自身变更，不递归父会话」的既有规则。

### 阶段六：前端（复用 + 最小新增）

1. 复用 `subagent_session_created` → 打开只读子代理 Tab；
2. 复用 `session_status` → 子代理 Tab 状态同步（RUNNING/COMPLETED/FAILED/CANCELLED）；
3. 主会话消息列表新增「后台子代理完成」卡片渲染（识别 `metadata.backgroundSubagentCompletion`），点击跳转子代理 Tab；
4. 父会话 `WAITING_SUBAGENTS` 对外映射为 `RUNNING`（或新增前端「等待后台子代理」的轻量态），不新增用户取消按钮。

### 阶段七：测试、记录与验收

1. 后端 Vitest：工具行为、管理器状态机、主循环挂起/续跑、取消级联、恢复交付分支；
2. `npm run build` + `npm test`；
3. 前端 `vue-tsc` 类型检查 + 手动走查完成卡片与子代理 Tab；
4. 更新根 `CHANGELOG.md` 的 `### 后端` 与 `### 前端（桌面 / Web / 安卓）`；
5. 不自动部署、不重启后端（由用户执行）。

---

## 8. 前端与事件协议

- 后台子代理创建：复用 `subagent_session_created`（含 `childSessionId`、`agentType`、`task`），前端据此打开只读子代理 Tab。
- 后台子代理状态：复用 `session_status`（`phase`），前端子代理 Tab 显示运行/完成/失败/取消。
- 完成卡片：父会话消息带 `metadata.backgroundSubagentCompletion`，前端渲染为「后台子代理完成」卡片，点击打开对应子代理 Tab。
- `WAITING_SUBAGENTS` 相位：后端在 `session_status` / 会话列表 / 详情响应中映射为 `RUNNING`（保持「运行中」可观测），并可选地在主会话输入区/状态区显示「等待后台子代理」的轻提示（不做复杂状态页）。

---

## 9. 落地清单

### 数据库

- [ ] 确认 `subagent_execution.invocation_type` 支持 `BACKGROUND`（无结构变更，更新注释）
- [ ] 确认 `session.phase` 支持 `WAITING_SUBAGENTS`（无结构变更）
- [ ] （不做）新增索引

### 后端（backend-ts）

- [ ] 扩展 `SubagentExecution.invocationType` 类型
- [ ] 新增 `BackgroundSubagentManager`
- [ ] 扩展 `DelegateTool.buildSubContext` 排除后台工具族
- [ ] 新增 `spawn_subagent` 工具
- [ ] 新增 `check_subagent` 工具
- [ ] 新增 `cancel_subagent` 工具
- [ ] 新增 `wait_subagents` 工具
- [ ] `AgentLoop` 每轮开始消费后台完成结果
- [ ] `AgentLoop` 结束点自动挂起（`WAITING_SUBAGENTS`）
- [ ] `BackgroundSubagentManager.onCompleted` 触发续跑
- [ ] 父会话取消级联取消后台子代理
- [ ] `SubagentResultDeliveryService` 支持 `BACKGROUND` 完成通知交付
- [ ] 崩溃恢复扫描纳入 `BACKGROUND`
- [ ] 文件变更归集支持 `BACKGROUND`
- [ ] 装配 `create-app.ts` 依赖
- [ ] 新增 Vitest 用例

### 前端（desktop，共用 Web/安卓）

- [ ] 复用子代理 Tab 只读展示后台子代理
- [ ] 新增「后台子代理完成」卡片渲染与跳转
- [ ] `WAITING_SUBAGENTS` 对外映射为 `RUNNING`
- [ ] （不做）用户手动取消后台子代理按钮

### 验证与发布

- [ ] `cd backend-ts && npm run build`
- [ ] `cd backend-ts && npm test`
- [ ] `cd desktop && npx vue-tsc --noEmit`（或项目既有类型检查）
- [ ] 更新 `CHANGELOG.md`
- [ ] 用户确认后部署，后端重启由用户执行

---

## 10. 测试方案（核心场景）

| 编号 | 场景 | 预期 |
|---|---|---|
| T1 | 主代理 `spawn_subagent` 后继续执行其他工具 | spawn 立即返回，子代理在后台并行执行 |
| T2 | 主代理 `check_subagent(task_id)` 查询单个 | 返回状态/轮次/用量/最近输出摘要 |
| T3 | 主代理 `check_subagent()` 列全部 | 返回当前父会话全部后台子代理状态 |
| T4 | 主代理 `wait_subagents()` 等待 | 全部结束后返回汇总结果，主线继续 |
| T5 | 主线结束但仍有后台子代理运行 | 主循环挂起（`WAITING_SUBAGENTS`），不进入终态 |
| T6 | 最后一个后台子代理完成 | 父会话自动续跑，产出综合结论 |
| T7 | 后台子代理在主线运行中完成 | 结果以完成卡片 + 下轮上下文注入，主代理主动感知 |
| T8 | 主代理 `cancel_subagent(task_id)` | 子代理收尾 `CANCELLED`，回传取消结果 |
| T9 | 父会话被取消 | 级联取消全部后台子代理，结果 `SUPPRESSED` |
| T10 | LOCAL 模式后台子代理 | 继承 LOCAL，经 Electron 执行工具 |
| T11 | 后台子代理尝试 `spawn_subagent` | 工具不可用（已从子代理工具集排除） |
| T12 | 后端重启时后台子代理运行中 | 恢复原执行与子会话，交付结果后恢复父会话 |
| T13 | 后台子代理完成结果交付前重启 | 重启后继续交付，不重复注入 |
| T14 | 后台子代理文件变更归集 | 主任务变更清单包含子代理修改的文件 |

---

## 11. 风险与控制

| 风险 | 控制措施 |
|---|---|
| 无超时导致后台子代理或挂起无限等待 | 用户明确选择「无上限、无超时」；保留父会话取消级联作为人工止损手段 |
| 无并发上限导致大量 LLM 并发 | 由 `agentExecutor` 线程池的既有 core/max/queue 上限兜底；超限走现有 reject 语义，不在本次新增硬并发限制 |
| 完成通知与同步 delegate 的 assistant+TOOL 交付混淆 | 通过 `invocation_type === 'BACKGROUND'` 显式分支，交付形式不同 |
| 挂起后父会话被误判为终态 | 新增非终态相位 `WAITING_SUBAGENTS`，恢复/终态判断函数需排除该相位 |
| 子代理嵌套导致树状等待 | 从子代理工具集排除全部后台工具族 |
| 完成结果重复注入 | 以 `execution_id` + `delivery_status` 事务幂等 |
| LOCAL 无客户端时后台子代理挂起 | 继承现有 LOCAL 等待逻辑；无超时决策下由父取消级联兜底 |

---

## 12. 验收标准

1. 主代理调用 `spawn_subagent` 后不阻塞，可继续主线工作；
2. `check_subagent` 能查单个与全部后台子代理进度；
3. `cancel_subagent` 能取消指定后台子代理并回传取消结果；
4. 后台子代理完成时，主代理无需轮询即可在下轮感知到完成结果，父会话出现完成卡片；
5. 主循环结束时若仍有后台子代理运行，父会话进入 `WAITING_SUBAGENTS`，全部结束后自动续跑；
6. `wait_subagents` 能阻塞等待全部后台子代理结束并返回汇总；
7. 父会话取消时级联取消全部后台子代理；
8. 后台子代理无法再派生后台子代理；
9. 后端重启后运行中的后台子代理可恢复，完成结果可交付，父会话可续跑；
10. 后台子代理文件变更归集到父任务变更清单；
11. CLOUD 与 LOCAL 两种模式均可运行；
12. 现有同步 `delegate` / `delegate_followup` 行为不回归。
