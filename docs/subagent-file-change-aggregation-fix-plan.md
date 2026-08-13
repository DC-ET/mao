# 子代理文件变更归集修复计划

## 1. 问题背景

主任务执行需求开发时，可以通过 `delegate` 或 `delegate_followup` 调用子代理。子代理与主任务共享工作区，因此子代理新增或编辑的文件同样属于本次主任务的交付结果。

当前主任务完成后，主任务轮次下方的“文件变更”仅显示主代理直接通过 `write_file`、`edit_file` 修改的文件。子代理修改的文件只能在对应子代理会话中看到，未归集到主任务，导致用户看到的任务变更清单不完整。

## 2. 现状与根因

### 2.1 文件变更采集

`write_file` 和 `edit_file` 的工具结果包含 `file_change` 与内部 diff 信息。`HarnessService.saveFileChanges()` 将其写入 `message_file_change`，并关联：

- 当前 ASSISTANT 消息 ID；
- 当前执行会话 ID；
- 文件路径、变更类型、增删行数和 diff 内容。

主代理执行时，记录使用主会话 ID；子代理通过独立的持久化回调执行，记录使用子代理的 `childSessionId`。因此子代理文件变更已正常采集，没有数据丢失。

相关代码：

- `backend/src/main/java/cn/etarch/mao/harness/core/HarnessService.java`
- `backend/src/main/java/cn/etarch/mao/harness/delegate/SubAgentVisibilityService.java`
- `backend/src/main/java/cn/etarch/mao/session/entity/FileChange.java`

### 2.2 主会话历史查询

主会话消息接口按主会话 ID 和当前页消息 ID 查询 `message_file_change`：

```text
message_file_change.session_id = 主会话 ID
message_file_change.message_id IN 当前页消息 ID
```

子代理变更的 `session_id` 和 `message_id` 均属于子会话，因此不会出现在主会话接口响应中。

相关代码：

- `backend/src/main/java/cn/etarch/mao/session/service/SessionService.java`
- `backend/src/main/java/cn/etarch/mao/session/controller/SessionController.java`

### 2.3 前端轮次汇总

前端只汇总主会话当前轮次消息携带的 `fileChanges`：

```ts
const fileChanges = [...steps, ...(reply ? [reply] : [])]
  .flatMap(message => message.fileChanges || [])
```

由于主会话消息接口未返回子代理变更，前端无法展示完整清单。

相关代码：

- `desktop/src/composables/useMessageRounds.ts`
- `desktop/src/utils/chatMessage.ts`
- `desktop/src/components/chat/FileChangePanel.vue`

## 3. 修复目标

1. 主任务完成后，对应主任务轮次展示主代理及本轮子代理产生的全部文件变更。
2. 子代理会话内继续展示其自身文件变更。
3. 支持同一轮并行调用多个子代理，并准确归属到各自的父 `delegate` 工具调用。
4. 支持 `delegate_followup`，且只归集本次追问执行新增的文件变更。
5. 同一路径被主代理或多个子代理反复修改时，列表按路径合并并保留可用 diff。
6. 不将独立边路任务 `SIDE_TASK` 的文件变更自动归入主任务。
7. 子代理失败或取消前已经成功完成的文件修改仍应展示。
8. 不改变 LLM 上下文和工具结果内容，仅调整任务结果的文件变更归集与展示。

## 4. 总体方案

采用“执行级精确关联 + 后端归集”的方案：

1. 在 `subagent_execution` 中记录触发本次子代理执行的父工具调用 ID。
2. 在每次子代理执行开始和结束时记录子会话消息边界。
3. 主会话消息接口解析当前页主消息中的 `delegate` / `delegate_followup` 工具调用 ID。
4. 根据工具调用 ID 找到对应 `subagent_execution`。
5. 根据执行记录中的子会话和消息边界查询文件变更。
6. 将子代理变更附加到触发委派的父 ASSISTANT 消息上。
7. 前端沿用现有轮次汇总和按路径合并逻辑，只补充来源字段支持。

不采用按创建时间推断归属的方案。并行工具调用、长时间子代理执行和后续追问都会使时间范围不可靠，可能把变更挂到错误轮次。

## 5. 数据库调整

新增 Flyway 迁移，为 `subagent_execution` 增加：

```sql
ALTER TABLE subagent_execution
    ADD COLUMN parent_tool_call_id VARCHAR(128) NULL
        COMMENT '触发本次执行的父会话 delegate/delegate_followup 工具调用 ID',
    ADD COLUMN start_message_id BIGINT NULL
        COMMENT '本次执行开始前子会话最后一条消息 ID',
    ADD COLUMN end_message_id BIGINT NULL
        COMMENT '本次执行结束后子会话最后一条消息 ID';

CREATE INDEX idx_sae_parent_tool_call
    ON subagent_execution(parent_session_id, parent_tool_call_id);
```

字段语义：

- `parent_tool_call_id`：将父消息中的工具调用与子代理执行精确关联。
- `start_message_id`：本次执行开始前的子会话消息边界；首次委派可为初始 USER 消息之前的最后消息 ID，若不存在则按 `0` 处理。
- `end_message_id`：本次执行结束后的最后消息 ID。
- 本次执行文件变更范围为 `(start_message_id, end_message_id]`。

不修改 `message_file_change` 表结构。现有 `session_id` 和 `message_id` 足以定位执行范围内的变更。

## 6. 后端实施步骤

### 6.1 扩展子代理执行实体

修改：

- `backend/src/main/java/cn/etarch/mao/harness/delegate/entity/SubagentExecution.java`

增加字段：

```java
private String parentToolCallId;
private Long startMessageId;
private Long endMessageId;
```

### 6.2 首次委派记录执行关联

修改：

- `backend/src/main/java/cn/etarch/mao/harness/tool/impl/DelegateTool.java`

创建 `SubagentExecution` 时：

1. 读取 `ToolCallContext.getToolCallId()`。
2. 写入 `parentToolCallId`。
3. 保存子代理初始 USER 消息后，确定本次执行起始边界。
4. 执行结束后查询子会话最后一条消息 ID，写入 `endMessageId`。
5. 无论完成、失败还是取消，只要子会话已创建，都尽可能写入结束边界。

执行边界更新应与现有 `markExecutionTerminal()` 集中处理，避免不同终态路径遗漏。

### 6.3 追问执行记录关联和边界

修改：

- `backend/src/main/java/cn/etarch/mao/harness/tool/impl/DelegateFollowupTool.java`

在保存本次追问 USER 消息前：

1. 查询子会话当前最后一条消息 ID并保存为 `startMessageId`。
2. 创建执行记录时写入当前 `ToolCallContext.getToolCallId()`。
3. 执行结束后写入 `endMessageId`。

这样同一个子代理会话的多次 `delegate_followup` 可以分别归集，不会重复返回该子会话的全部历史变更。

### 6.4 增加执行范围文件变更查询

修改：

- `backend/src/main/java/cn/etarch/mao/session/service/SessionService.java`

新增服务方法，输入父会话 ID和当前页父工具调用 ID集合，返回按父工具调用 ID分组的子代理文件变更。

建议返回结构：

```java
Map<String, List<AggregatedFileChange>>
```

查询步骤：

1. 查询 `parent_session_id = 当前主会话` 且 `parent_tool_call_id IN (...)` 的执行记录。
2. 对每条执行记录按以下条件查询文件变更：
   - `message_file_change.session_id = child_session_id`
   - `message_file_change.message_id > start_message_id`
   - `message_file_change.message_id <= end_message_id`
3. 将结果按 `parent_tool_call_id` 分组。
4. 为每项补充子代理来源信息。

首期可按执行记录逐条查询以保证实现清晰；如果查询数量成为问题，再增加 Mapper 联表查询。由于消息接口默认只返回少量轮次，执行记录数量有限，不需要提前引入复杂 SQL。

### 6.5 主消息接口归集

修改：

- `backend/src/main/java/cn/etarch/mao/session/controller/SessionController.java`

扩展 `toMessageVOList()`：

1. 保留现有主会话文件变更查询。
2. 解析当前页所有 ASSISTANT 消息的 `toolCalls`。
3. 收集工具名为 `delegate` 或 `delegate_followup` 的工具调用 ID。
4. 批量查询这些调用对应的子代理文件变更。
5. 将子代理变更追加到包含该工具调用的父 ASSISTANT 消息 `fileChanges`。

主消息上的 `fileChanges` 顺序建议保持：

1. 主代理直接变更；
2. 按父消息工具调用顺序追加子代理变更；
3. 每个子代理内部按 `message_file_change.id` 升序。

控制器不负责按文件路径最终合并，继续由现有前端 `FileChangePanel` 完成展示层合并，避免改变单条消息的审计信息。

### 6.6 文件变更来源字段

扩展 `FileChangeVO`：

```java
private Long sourceSessionId;
private String sourceType;
private String sourceAgentType;
```

字段值：

- 主代理直接变更：
  - `sourceSessionId = 当前主会话 ID`
  - `sourceType = MAIN`
  - `sourceAgentType = null`
- 子代理变更：
  - `sourceSessionId = childSessionId`
  - `sourceType = SUBAGENT`
  - `sourceAgentType = subagent_execution.agent_type`

子代理自身消息接口返回变更时，也可将来源标记为 `SUBAGENT`，但不得再次归集其父会话或其他子会话的变更。

### 6.7 管理后台一致性

检查：

- `backend/src/main/java/cn/etarch/mao/session/controller/AdminSessionController.java`

管理后台若也需要在主会话历史中看到完整任务变更，应复用同一服务层归集逻辑。不要在两个控制器中各自实现关联算法。

如果本次范围只覆盖用户端，应保证管理端原有查询不受影响，并将管理端归集列为后续事项。

## 7. 前端实施步骤

### 7.1 扩展文件变更类型

修改：

- `desktop/src/types/chat.ts`

增加：

```ts
sourceSessionId?: string
sourceType?: 'MAIN' | 'SUBAGENT'
sourceAgentType?: string
```

### 7.2 映射接口来源字段

修改：

- `desktop/src/utils/chatMessage.ts`

在 `mapMessagesWithFileChanges()` 中映射：

```ts
sourceSessionId
sourceType
sourceAgentType
```

### 7.3 保持现有轮次汇总

`useMessageRounds()` 无需额外拉取子代理会话。后端将子代理变更附加到父 ASSISTANT 消息后，现有轮次汇总逻辑会自动包含完整变更。

### 7.4 文件路径合并规则

检查并补充：

- `desktop/src/components/chat/FileChangePanel.vue`
- `desktop/src/stores/session.ts`

同一路径合并规则保持：

1. 累加 `linesAdded` 和 `linesDeleted`。
2. 任一变更为 `CREATED` 时，最终类型保留 `CREATED`。
3. 两个 `SNAPSHOT` 合并时保留最早 `beforeContent` 和最新 `afterContent`。
4. 出现 `PATCH` 时沿用现有 patch 拼接逻辑。
5. 来源不同时可保留来源集合，但首期不要求修改 UI 展示。

不要仅按 `toolCallId` 去重。子代理内部文件工具调用 ID与父 `delegate` 调用 ID不是同一个概念。

### 7.5 实时与终态行为

保留当前实时策略：

- 子代理执行中，`file_change` WS 事件写入子会话缓存，在子代理 Tab 中可见。
- 不把子代理实时事件直接复制到父会话缓存，避免重复累加和未完成轮次提前展示。
- 主任务进入终态后，现有 phase watcher 重新拉取主会话消息；接口返回归集后的完整列表。

相关代码：

- `desktop/src/composables/useStreamWS.ts`
- `desktop/src/composables/useChat.ts`

## 8. 合并与 Diff 语义

文件变更列表展示的是任务执行期间的操作累计，不是最终 Git diff。归集时应遵循现有语义：

- 主代理新增文件，子代理随后修改：显示 `CREATED`，累计新增和删除行数。
- 主代理修改文件，子代理再次修改：显示 `MODIFIED`，合并 diff。
- 多个子代理修改同一文件：列表只显示一个路径，累计各次变更。
- 文件先修改后恢复原状：仍可能显示操作累计；本次修复不改为 Git 工作区最终快照。

如果后续产品要求展示“任务结束时相对任务开始时的最终净变化”，应另行设计任务级工作区快照，不能与本次消息工具变更归集混在一起。

## 9. 边界场景

### 9.1 并行委派

同一父 ASSISTANT 消息可包含多个 `delegate` 调用。必须使用 `parent_tool_call_id` 分别关联，不得只按父会话或创建时间匹配。

### 9.2 子代理失败或取消

只要文件工具已经成功执行并落库，无论子代理最终状态为 `FAILED` 或 `CANCELLED`，其变更都属于本次任务，应归集展示。

### 9.3 委派工具本身失败

如果子会话未创建或没有执行记录，不返回子代理变更。主消息仍正常显示主代理直接变更。

### 9.4 多次追问

每次 `delegate_followup` 都产生独立 `subagent_execution` 和消息边界，只归集该次执行范围内的变更。

### 9.5 消息分页

仅解析当前页主消息中的工具调用 ID并查询对应执行记录。历史轮次翻页时按同样逻辑返回，避免首屏加载所有子代理文件变更。

### 9.6 子代理 Tab

请求子代理会话自身消息时，仅返回自身消息直接关联的文件变更，不应再次根据其父关系做聚合。

### 9.7 边路任务

`SIDE_TASK` 是独立任务，不自动归集进主任务。边路任务内部触发的子代理变更应归集到边路任务自己的轮次，而不是主任务。

因此归集逻辑应以“当前请求会话作为 `subagent_execution.parent_session_id`”查询，不能使用主任务的树形全量子代理列表。

### 9.8 历史数据

迁移前的 `subagent_execution.parent_tool_call_id` 和消息边界为空。禁止按时间猜测归属，以免把历史变更挂到错误轮次。

历史行为：

- 主任务仍只显示原有直接变更。
- 子代理 Tab 仍能看到子代理自身变更。
- 新版本部署后产生的执行记录支持完整归集。

项目当前无需兼容存量数据，因此也可以选择在非生产环境清理旧执行记录后验证。

## 10. 测试计划

### 10.1 后端单元测试

新增或扩展测试覆盖：

1. 主代理直接修改一个文件、子代理修改另一个文件，主消息返回两项。
2. 主代理与子代理修改同一路径，父消息返回两条审计项，前端可合并。
3. 同一轮并行两个 `delegate`，分别归属到正确工具调用。
4. 子代理多轮工具调用产生多个文件变更，全部归入对应父调用。
5. `delegate_followup` 只返回本次追问消息边界内的变更。
6. 同一子会话连续两次 followup，不重复上一轮变更。
7. 子代理 `FAILED`，已落库文件变更仍返回。
8. 子代理 `CANCELLED`，已落库文件变更仍返回。
9. 委派未创建子会话时不产生额外变更。
10. 请求子代理自身消息时不发生父子递归归集。
11. 边路任务触发子代理时，只归集到边路任务，不归集到主任务。
12. 消息分页只查询并返回当前页工具调用关联的变更。
13. 旧执行记录关联字段为空时安全跳过。

重点验证文件：

- `DelegateToolTest`
- `DelegateFollowupToolTest`
- `SessionService` 新增聚合服务测试
- `SessionController` 消息接口测试

### 10.2 前端测试

补充测试覆盖：

1. `mapMessagesWithFileChanges()` 正确映射来源字段。
2. 一个轮次中主代理与子代理变更均进入 `round.fileChanges`。
3. `FileChangePanel` 按路径合并主代理与子代理的同文件变更。
4. 两个 `SNAPSHOT` 保留最早 before 和最新 after。
5. 主任务完成后历史回拉不会与子代理实时缓存重复累计。

### 10.3 构建验证

```bash
cd backend && mvn test
cd desktop && npm run build
```

不得自动重启 Mao 后端服务。后端改动部署后由用户自行重启服务。

## 11. 预计修改文件

后端：

- `backend/src/main/resources/db/migration/Vxxx__add_subagent_execution_file_change_scope.sql`
- `backend/src/main/java/cn/etarch/mao/harness/delegate/entity/SubagentExecution.java`
- `backend/src/main/java/cn/etarch/mao/harness/tool/impl/DelegateTool.java`
- `backend/src/main/java/cn/etarch/mao/harness/tool/impl/DelegateFollowupTool.java`
- `backend/src/main/java/cn/etarch/mao/session/service/SessionService.java`
- `backend/src/main/java/cn/etarch/mao/session/controller/SessionController.java`
- 对应后端测试文件

前端：

- `desktop/src/types/chat.ts`
- `desktop/src/utils/chatMessage.ts`
- 必要时调整 `desktop/src/components/chat/FileChangePanel.vue`
- 对应前端测试文件

发版说明：

- `CHANGELOG.md`

## 12. 实施顺序

1. 新增数据库迁移和实体字段。
2. 为 `delegate` 记录父工具调用 ID与消息边界。
3. 为 `delegate_followup` 记录父工具调用 ID与消息边界。
4. 实现执行范围内的文件变更查询服务。
5. 在主会话消息接口中按父工具调用归集子代理变更。
6. 增加来源字段并完成前端映射。
7. 补充后端和前端测试。
8. 执行后端测试与前端构建。
9. 更新 `CHANGELOG.md`。

## 13. 验收标准

使用主任务执行以下流程：

1. 主代理直接编辑文件 A。
2. 主代理调用 coder 子代理编辑文件 B、C。
3. 主代理再次编辑文件 B。
4. 主任务完成。

主任务对应轮次下方应显示：

- 文件 A；
- 文件 B；
- 文件 C。

其中：

- 文件 B 只显示一次，增删行数和 diff 覆盖主代理与子代理的全部操作。
- 打开 coder 子代理 Tab，仍能看到子代理自身对 B、C 的变更。
- 刷新页面后结果一致。
- 并行调用多个子代理时不遗漏、不串轮次。
- 后续 `delegate_followup` 的新变更只出现在对应追问所在的父任务轮次中。
