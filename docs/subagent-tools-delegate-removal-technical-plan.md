# Subagent 工具体系改造与 delegate 移除技术方案

## 1. 需求背景

当前项目同时存在两套子代理调用模型：

- 同步委派模型：`delegate` / `delegate_followup`
- 后台异步模型：`spawn_subagent` / `check_subagent` / `cancel_subagent` / `wait_subagents`

从当前代码看，后台子代理能力已经具备独立执行记录、子会话、可查询进度、可取消、自动结果回传等基础能力：

- `spawn_subagent` 已返回 `task_id` 和 `child_session_id`。
- `BackgroundSubagentManager` 负责后台执行、取消、结果缓存和父会话回传。
- `subagent_execution` 已记录父会话、子会话、代理类型、执行类型、状态、结果和统计信息。

但当前 `delegate_followup` 只支持对子代理空闲后的追问，并明确拒绝运行中的子代理会话。新的目标是废弃并移除 `delegate` 工具，统一用 `subagent` 系列工具满足子代理派发、查询、取消、等待、追问和运行中纠偏需求。

## 2. 需求描述

### 2.1 要做的事情

1. 移除对外暴露的 `delegate` 工具。
2. 移除对外暴露的 `delegate_followup` 工具。
3. 新增对外暴露工具 `subagent_followup`。
4. 保留并继续使用以下后台子代理工具：
   - `spawn_subagent`
   - `check_subagent`
   - `cancel_subagent`
   - `wait_subagents`
5. `subagent_followup` 支持两种语义：
   - 子代理空闲时：追加追问消息并启动新的后台 followup 执行。
   - 子代理运行中时：将本次调用理解为纠偏，先中断当前执行，再追加纠偏消息并启动新的后台 followup 执行。
6. 所有新子代理执行统一为异步后台执行。
7. 历史 `delegate` / `delegate_followup` 记录保留展示和审计兼容。
8. 前端展示需要体现纠偏中断和 delegate 移除后的工具名称变化。
9. 新执行只使用 `BACKGROUND` 和 `FOLLOWUP` 两类 `invocation_type`；历史 `DELEGATE` 只读兼容。
10. 不新增数据库表、字段或迁移脚本。

### 2.2 不做的事情

1. 不保留同步等待式 `delegate` 调用语义。
2. 不新增 `delegate` 或 `delegate_followup` 的隐藏运行时兼容工具。
3. 不允许子代理内部继续派生、追问、取消或等待其他子代理。
4. 不新增 `INTERRUPTED` 状态。
5. 不把纠偏中断的旧执行结果回传给主代理。
6. 不允许跨父会话对子代理调用 `subagent_followup`。
7. 不支持同一个 child session 并发运行多个子代理执行。
8. 不新增纠偏队列；旧执行无法在宽限期内结束时，本次纠偏失败。
9. 不做数据库结构调整。

## 3. 当前代码现状

### 3.1 工具注册

当前工具注册位于 `backend-ts/src/harness/tool/tool-registry.ts`，其中同时注册了：

- `DelegateTool`
- `DelegateFollowupTool`
- `SpawnSubagentTool`
- `CheckSubagentTool`
- `CancelSubagentTool`
- `WaitSubagentsTool`

工具调度白名单位于 `backend-ts/src/harness/tool/tool-dispatcher.ts`，当前包含 `delegate`、`delegate_followup` 和后台子代理工具。

### 3.2 delegate_followup 当前限制

`DelegateFollowupTool` 在执行前会检查目标子代理会话状态。如果 `childSession.phase === 'RUNNING'`，当前实现直接返回错误：子代理正在执行中，无法追问。

`SubagentInvocationService.createFollowup` 也会在事务中拒绝 `RUNNING` / `RESUMING` 的子代理会话。

### 3.3 后台子代理运行机制

`BackgroundSubagentManager.spawn` 创建后台子代理后，返回：

- `taskId`
- `childSessionId`

后台执行由 `BackgroundSubagentManager.runBackground` 负责。该方法会：

1. 校验执行记录是否仍需运行。
2. 获取或注册 child session 的 cancel flag。
3. 构建子代理执行上下文。
4. 调用可见执行服务运行子代理。
5. 根据运行结果更新 `subagent_execution`。
6. 将完成结果写入父会话结果缓存和父会话消息。
7. 清理 cancel flag 和本地工具会话注册。

### 3.4 关键风险

当前 cancel flag 以 `sessionId` 为 key 存储。运行中纠偏如果在旧执行未完成清理前立即启动新执行，旧执行的 finally 逻辑可能删除同一个 child session 的新 cancel flag。

因此本方案要求：运行中纠偏必须先等待旧 run 收尾，再创建并启动新 followup 执行。

## 4. 技术选型

### 4.1 工具命名

新增工具命名为：

```text
subagent_followup
```

最终对外暴露的子代理工具清单为：

```text
spawn_subagent
subagent_followup
check_subagent
cancel_subagent
wait_subagents
```

`delegate` 和 `delegate_followup` 不再对外暴露，也不再作为隐藏运行时工具保留。

### 4.2 执行模型

所有新子代理任务统一走后台异步模型：

- `spawn_subagent`：创建新的子代理会话和后台执行，立即返回。
- `subagent_followup`：复用既有子代理会话创建新的后台 followup 执行，立即返回。
- `check_subagent`：查询后台执行状态。
- `cancel_subagent`：取消后台执行。
- `wait_subagents`：等待当前父会话下的后台子代理完成并返回汇总结果。

### 4.3 纠偏模型

运行中调用 `subagent_followup` 时，系统将其解释为纠偏：

1. 通过 `child_session_id` 定位目标子代理会话。
2. 校验该子代理属于当前父会话。
3. 查找该 child session 当前运行中的后台执行。
4. 设置该 child session 的 cancel flag。
5. 等待旧执行在 30 秒宽限期内进入终态。
6. 将旧执行状态落为 `CANCELLED`，结果文本写明“因纠偏中断”。
7. 将旧执行 `deliveryStatus` 设为 `SUPPRESSED`，不向主代理回传旧执行取消结果。
8. 在子代理会话中保留一条可见说明，说明上一轮因纠偏中断。
9. 追加新的 USER 纠偏消息。
10. 创建新的 `FOLLOWUP` 执行。
11. 提交后台执行并立即返回新 `task_id`。

如果旧执行未能在 30 秒宽限期内结束，`subagent_followup` 返回失败，不创建新 followup 执行。

### 4.4 数据模型

不新增数据库迁移。

继续使用现有 `subagent_execution` 字段：

- `parent_session_id`
- `child_session_id`
- `agent_type`
- `invocation_type`
- `parent_tool_call_id`
- `delivery_status`
- `task_description`
- `status`
- `result`
- `started_at`
- `completed_at`
- `execution_start_message_id`
- `final_message_id`
- token 和工具调用统计字段

新执行类型规则：

- `spawn_subagent` 创建 `BACKGROUND`。
- `subagent_followup` 创建 `FOLLOWUP`。
- 历史 `DELEGATE` 只读兼容，不再新写。

执行状态规则：

- 正常完成：`COMPLETED`
- 执行失败：`FAILED`
- 用户取消或纠偏中断：`CANCELLED`

### 4.5 权限与归属

`subagent_followup` 必须满足：

1. 当前会话存在。
2. 目标 `child_session_id` 存在。
3. 目标会话 `sessionType` 为 `SUBAGENT`。
4. 目标子代理的 `parentSessionId` 等于当前会话 ID。

不支持同用户跨父会话纠偏。

### 4.6 子代理内部工具范围

子代理执行上下文中排除所有子代理编排工具：

```text
delegate
delegate_followup
spawn_subagent
subagent_followup
check_subagent
cancel_subagent
wait_subagents
```

其中 `delegate` 和 `delegate_followup` 作为历史工具名继续出现在排除列表中，防止旧上下文或历史配置重新暴露。

## 5. 实现步骤

### 5.1 后端工具层改造

1. 新增 `SubagentFollowupTool`。
2. 从工具注册中移除 `DelegateTool` 和 `DelegateFollowupTool`。
3. 在工具注册中加入 `SubagentFollowupTool`。
4. 从工具调度白名单中移除 `delegate` 和 `delegate_followup`。
5. 在工具调度白名单中加入 `subagent_followup`。
6. 更新 `spawn_subagent` 工具描述，移除“需要立即结果请用 delegate”的说明。
7. 更新后台子代理工具提示，说明 `subagent_followup` 支持空闲追问和运行中纠偏。

### 5.2 后台子代理管理器改造

在 `BackgroundSubagentManager` 中新增 followup 编排能力：

```ts
followup(parentSessionId, childSessionId, task, parentToolCallId)
```

该方法负责：

1. 校验父会话和子代理会话归属。
2. 解析目标 child session 的 `agentType`。
3. 判断 child session 是否运行中。
4. 空闲时直接创建 followup 执行并提交后台运行。
5. 运行中时执行纠偏中断流程。
6. 返回新执行的 `task_id`、`child_session_id`、`status` 和 `corrected` 标记。

### 5.3 运行中纠偏流程

新增内部方法：

```ts
interruptRunningForCorrection(parentSessionId, childSessionId)
```

该方法负责：

1. 查找 `child_session_id` 当前运行中的 `subagent_execution`。
2. 确认该执行属于当前父会话。
3. 获取或注册 child session cancel flag。
4. 设置 cancel flag 为 true。
5. 等待旧执行终止，宽限期 30 秒。
6. 若终止成功：
   - 将旧执行 `status` 更新为 `CANCELLED`。
   - 将旧执行 `result` 更新为“后台子代理因纠偏中断”。
   - 将旧执行 `deliveryStatus` 更新为 `SUPPRESSED`。
   - 写入 `completedAt`。
   - 在子代理会话追加一条可见说明消息。
7. 若终止失败：
   - 返回失败。
   - 不创建新的 followup 执行。

### 5.4 followup 执行创建

调整或新增 `SubagentInvocationService` 方法：

```ts
createBackgroundFollowup(parent, childSessionId, agentType, task, parentToolCallId)
```

要求：

1. 事务内锁定 child session。
2. 校验 child session 属于 parent。
3. 校验 child session 此时不处于 `RUNNING` / `RESUMING`。
4. 将 child session phase 设置为 `RUNNING`。
5. 插入 `subagent_execution`，`invocationType` 为 `FOLLOWUP`。
6. 插入 USER 追问/纠偏消息。
7. 回写 `executionStartMessageId`。

### 5.5 后台执行复用

将 `runBackground` 泛化为可执行 `BACKGROUND` 和 `FOLLOWUP`：

1. 入参继续使用 `SubagentExecution`、`Session`、`AgentDefinition`。
2. 不根据 `invocationType` 限制执行。
3. 完成后沿用现有结果聚合、父会话注入、文件变更复制和状态更新流程。
4. `FOLLOWUP` 的完成结果同样进入 `wait_subagents` 和自动后台结果注入。

### 5.6 历史兼容

保留以下历史兼容能力：

1. `ToolResultSummarizer` 能继续识别历史 `delegate` / `delegate_followup` 工具消息。
2. `subagent_execution` 中历史 `DELEGATE` 记录继续能在会话详情、子代理列表和审计中展示。
3. 恢复逻辑继续能处理历史 `DELEGATE` 记录，不再创建新的 `DELEGATE` 记录。

不保留以下兼容能力：

1. 不在工具注册中注册 `delegate`。
2. 不在工具注册中注册 `delegate_followup`。
3. 不允许模型继续调用 `delegate` 或 `delegate_followup`。

### 5.7 前端展示调整

前端需要调整以下展示：

1. 工具摘要展示新增 `subagent_followup`。
2. 历史 `delegate` / `delegate_followup` 仍按原语义摘要展示。
3. 子代理列表或任务状态中，`CANCELLED` 且结果包含纠偏中断语义时展示为“已纠偏中断”。
4. 工具说明、帮助文案、调试面板中不再推荐或展示 `delegate`。
5. 父会话中不展示被纠偏中断旧执行的结果注入，只展示新 followup 执行完成结果。

### 5.8 CHANGELOG

本改动对 Agent 工具行为和前端展示可见，需要更新根目录 `CHANGELOG.md`：

- `### 后端`：记录移除 `delegate`，新增 `subagent_followup`，支持运行中纠偏。
- `### 前端（桌面 / Web / 安卓）`：记录子代理工具名称和纠偏中断展示调整。

## 6. 落地清单

### 6.1 后端文件

需要修改：

- `backend-ts/src/harness/tool/tool-registry.ts`
- `backend-ts/src/harness/tool/tool-dispatcher.ts`
- `backend-ts/src/harness/tool/impl/background-subagent-tools.ts`
- `backend-ts/src/harness/delegate/background-subagent-manager.ts`
- `backend-ts/src/harness/delegate/subagent-invocation.service.ts`
- `backend-ts/src/session/util/tool-result-summarizer.ts`
- `backend-ts/src/session/util/session-utils.spec.ts`

需要新增或重命名：

- 新增 `backend-ts/src/harness/tool/impl/subagent-followup-tool.ts`，或在 `background-subagent-tools.ts` 中新增 `SubagentFollowupTool`。

需要删除运行时引用：

- `DelegateTool` 注册引用。
- `DelegateFollowupTool` 注册引用。

保留历史展示代码：

- `delegate` / `delegate_followup` 的历史摘要逻辑。
- 历史 `DELEGATE` execution 的读取和展示逻辑。

### 6.2 前端文件

需要通过代码搜索确认具体落点，重点检查：

- `desktop/src/` 下工具调用展示、消息摘要、子任务状态展示相关组件。
- `admin/src/` 下会话详情或审计展示相关组件。

前端改造目标：

1. 新增 `subagent_followup` 展示文案。
2. 移除新增界面中对 `delegate` 的推荐展示。
3. 保留历史 `delegate` 展示。
4. 对纠偏中断的 `CANCELLED` 状态展示为明确的纠偏语义。

### 6.3 文档与发版说明

需要修改：

- `CHANGELOG.md`

本技术方案文档位置：

- `docs/subagent-tools-delegate-removal-technical-plan.md`

## 7. 验收标准

### 7.1 工具暴露

1. 新会话可用工具中包含：
   - `spawn_subagent`
   - `subagent_followup`
   - `check_subagent`
   - `cancel_subagent`
   - `wait_subagents`
2. 新会话可用工具中不包含：
   - `delegate`
   - `delegate_followup`

### 7.2 spawn 行为

1. `spawn_subagent` 创建后台子代理。
2. 返回结果包含：
   - `success: true`
   - `task_id`
   - `child_session_id`
   - `status: RUNNING`
3. 创建的 execution `invocationType` 为 `BACKGROUND`。

### 7.3 空闲 followup 行为

1. 对已完成的子代理调用 `subagent_followup`。
2. 工具立即返回新 `task_id`。
3. 新 execution `invocationType` 为 `FOLLOWUP`。
4. 子代理会话中追加新的 USER 追问消息。
5. 新执行完成后结果可被 `check_subagent` / `wait_subagents` 获取。

### 7.4 运行中纠偏行为

1. 对运行中的子代理调用 `subagent_followup`。
2. 旧执行收到 cancel flag 并停止。
3. 旧 execution 状态为 `CANCELLED`。
4. 旧 execution `result` 写明因纠偏中断。
5. 旧 execution `deliveryStatus` 为 `SUPPRESSED`。
6. 子代理会话中保留纠偏中断说明。
7. 新 execution `invocationType` 为 `FOLLOWUP`。
8. 新执行完成后结果正常回传父会话。
9. 父会话不收到旧执行的取消结果。

### 7.5 纠偏超时行为

1. 如果旧执行 30 秒内未进入终态，`subagent_followup` 返回失败。
2. 失败时不创建新 followup execution。
3. 同一个 child session 不出现并发运行的多个 execution。

### 7.6 权限行为

1. 在非父会话中调用 `subagent_followup` 会失败。
2. 对非 `SUBAGENT` 会话调用 `subagent_followup` 会失败。
3. 对不存在的 `child_session_id` 调用会失败。

### 7.7 历史兼容

1. 历史 `delegate` 工具消息仍能正常摘要展示。
2. 历史 `delegate_followup` 工具消息仍能正常摘要展示。
3. 历史 `DELEGATE` execution 仍能在子代理列表和审计中展示。
4. 新执行不再写入 `DELEGATE` invocation type。

## 8. 测试方案

### 8.1 后端单测

新增或调整后端单测覆盖：

1. 工具注册不再包含 `delegate` / `delegate_followup`。
2. 工具注册包含 `subagent_followup`。
3. `spawn_subagent` 返回 `child_session_id`。
4. `subagent_followup` 空闲追问成功创建 `FOLLOWUP` execution。
5. `subagent_followup` 运行中纠偏会取消旧 execution 并创建新 execution。
6. 纠偏旧 execution 的 `deliveryStatus` 为 `SUPPRESSED`。
7. 纠偏超时返回失败且不创建新 execution。
8. 非父会话调用 `subagent_followup` 失败。
9. 子代理上下文中排除所有 subagent 编排工具。
10. 历史 `delegate` / `delegate_followup` 摘要兼容。

建议重点测试文件：

- `backend-ts/src/harness/tool/impl/delegate-followup-tool.spec.ts`：改造为 `subagent-followup-tool.spec.ts` 或迁移用例。
- `backend-ts/src/harness/delegate/subagent-execution-recovery.service.spec.ts`
- `backend-ts/src/session/util/session-utils.spec.ts`
- `backend-ts/src/harness/tool/tool-dispatcher.spec.ts`

### 8.2 构建检查

执行：

```bash
cd backend-ts && npm run build
cd backend-ts && npm test
```

前端涉及展示改动时执行对应构建检查：

```bash
cd desktop && npm run build
cd admin && npm run build
```

## 9. 实施顺序

1. 新增 `subagent_followup` 工具定义和 schema。
2. 在 `BackgroundSubagentManager` 中实现 followup 和纠偏编排。
3. 调整 `SubagentInvocationService`，支持后台 followup 创建。
4. 泛化后台执行流程以运行 `FOLLOWUP` execution。
5. 更新工具注册和调度白名单，移除 `delegate` / `delegate_followup`。
6. 更新子代理上下文工具排除列表。
7. 更新工具结果摘要与历史兼容展示。
8. 更新前端展示文案和状态展示。
9. 更新 CHANGELOG。
10. 补齐并运行后端单测。
11. 运行后端构建和必要前端构建。

## 10. 关键风险与处理

### 10.1 cancel flag 生命周期冲突

风险：旧 run finally 删除 child session cancel flag，影响新 run。

处理：运行中纠偏必须等待旧 run 完成 finally 清理后，才创建并启动新的 followup 执行。

### 10.2 同一 child session 并发执行

风险：旧执行未结束时启动新执行，导致消息流、phase、execution 统计互相污染。

处理：旧执行 30 秒内未结束则纠偏失败，不创建新执行。

### 10.3 历史记录展示破坏

风险：删除 delegate 相关工具代码后，历史消息摘要和审计显示退化。

处理：只移除运行时工具注册和调用入口，保留历史摘要和历史 execution 读取展示。

### 10.4 结果噪音

风险：纠偏导致父会话收到旧执行 `CANCELLED` 结果和新执行结果，干扰主代理。

处理：旧执行 `deliveryStatus` 设为 `SUPPRESSED`，只回传新执行结果。

## 11. 最终口径

本次改造的最终口径是：

1. `delegate` 和 `delegate_followup` 从运行时工具体系中移除。
2. `subagent` 系列成为唯一子代理编排工具体系。
3. `subagent_followup` 是唯一追问工具，并支持运行中纠偏。
4. 运行中纠偏通过“取消旧执行、等待收尾、创建新 followup 执行”的方式实现。
5. 所有新子代理执行都是后台异步执行。
6. 历史 delegate 数据只读兼容，不再产生新的 delegate 执行。
