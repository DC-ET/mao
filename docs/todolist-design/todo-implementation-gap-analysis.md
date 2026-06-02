# TodoList 集成改进技术方案

> 对照 `agent-todolist-design-pattern.md` 设计模式，逐项分析当前实现的差距并给出完整的改进方案。

---

## 差距总览

| 设计模式章节 | 当前实现状态 |
|---|---|
| 3.1 System Prompt 注入 | **缺失** — PromptEngine 无任何 todo 指令 |
| 3.2 Tool Prompt 行为规范 | **严重不足** — 仅一行 description，无触发条件/状态机/few-shot |
| 3.3 工具返回值行为反馈 | **缺失** — 返回原始数据，无行为指令嵌入 |
| 4 工具拆分策略 | **不符** — 单一 "todo" 工具 vs 设计的 4 个 CRUD 工具 |
| 数据模型 | **不完整** — 缺少 description、owner、blockedBy、active_form |
| 3.4 UI 可见性 | **部分实现** — 有组件但缺少关键 UX 细节 |
| 5 多 Agent 协作 | **完全缺失** |

---

## 一、System Prompt 注入

### 现状

[PromptEngine.java](backend/src/main/java/com/agentworkbench/harness/core/PromptEngine.java) 的 `buildSystemPrompt()` 方法（L51-90）组装 system prompt 时，只包含 Agent 人格、Working Directory、Current Time、Available Skills 四个段落，**完全没有注入 todo 工具的使用指令**。LLM 仅通过 tool definition 的 description 知道 `todo` 工具存在，但不知道"应该在什么场景下使用它"。

### 改进

在 `PromptEngine.buildSystemPrompt()` 末尾新增 `appendToolBehaviorHints()` 方法，当 `context.getTools()` 包含 `todo` 工具时动态注入行为指令：

```java
// PromptEngine.java - buildSystemPrompt() 末尾追加调用
appendToolBehaviorHints(sb, context);

private void appendToolBehaviorHints(StringBuilder sb, AgentExecutionContext context) {
    boolean hasTodoTool = context.getTools().stream()
            .anyMatch(t -> "todo".equals(t.getName()));
    if (!hasTodoTool) return;

    sb.append("## Task Management\n\n");
    sb.append("Use the `todo` tool to break down and manage your work.\n");
    sb.append("These tools are helpful for planning your work and helping the user track your progress.\n");
    sb.append("Mark each task as completed as soon as you are done with the task.\n");
    sb.append("Do not batch up multiple tasks before marking them as completed.\n\n");
}
```

设计要点：
- 动态检测：只在 agent 启用了 todo 工具时才注入，不污染不需要 todo 的 agent
- 祈使语气，指令而非建议
- 放在 system prompt 末尾，与 Available Skills 并列

---

## 二、Tool Prompt 行为规范

### 现状

`TodoTool.getDescription()` 返回一行简短描述，缺少触发条件、状态机说明、few-shot 示例、字段规范。

### 改进

引入独立的 tool prompt 文件机制，在 system prompt 中追加工具行为指南：

**Step 1 — Tool 接口扩展**

```java
// Tool.java 新增默认方法
default String getToolPrompt() { return null; }
```

**Step 2 — 创建 prompt 文件**

在 `backend/src/main/resources/prompts/` 下创建 `todo-tool-prompt.md`：

```markdown
## todo Tool Behavior Guide

### When to Use This Tool
- Complex multi-step tasks — When a task requires 3 or more distinct steps
- After receiving new instructions — Immediately capture user requirements as tasks
- When you start working on a task — Mark it as in_progress BEFORE beginning work
- After completing a task — Mark it as completed and add new follow-up tasks

### When NOT to Use This Tool
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
- The task can be completed in less than 3 trivial steps

### Status Machine
Status progresses: pending → in_progress → completed
- Exactly ONE task can be in_progress at any time
- Setting a task to in_progress automatically resets others to pending
- Mark completed IMMEDIATELY when done — do NOT batch completions

### Content Format
- Use imperative mood: "Fix authentication bug" (not "Auth bug fix")
- Be specific enough that another agent could execute the task

### Few-shot Examples

<example>
User: I want to add a dark mode toggle to the application settings.
Assistant: *Creates todo list with 4 items: toggle component, state management, CSS styles, update existing components*
*Begins working on the first task, marks it in_progress*

<reasoning>
The assistant used the todo list because:
1. Adding dark mode is a multi-step feature requiring multiple files
2. It helps the user track which parts are done vs pending
</reasoning>
</example>

<example>
User: What does the getCwd function do?
Assistant: *Does NOT create a todo list, just reads the function and explains it*

<reasoning>
This is a single, straightforward question — no task tracking needed.
</reasoning>
</example>
```

**Step 3 — TodoTool 覆写**

```java
// TodoTool.java
@Override
public String getToolPrompt() {
    return resourceLoader.load("prompts/todo-tool-prompt.md");
}
```

**Step 4 — PromptEngine 注入**

```java
// PromptEngine.java - buildSystemPrompt() 中，skill catalog 之后
private void appendToolPrompts(StringBuilder sb, AgentExecutionContext context) {
    for (Tool tool : context.getTools()) {
        String prompt = tool.getToolPrompt();
        if (prompt != null && !prompt.isEmpty()) {
            sb.append(prompt).append("\n\n");
        }
    }
}
```

**Step 5 — 同步优化 description**

将 `TodoTool.getDescription()` 从一行扩展为包含关键行为规范的精简版（作为 tool prompt 的兜底）：

```java
@Override
public String getDescription() {
    return """
        Manage a task plan for the current session. Use this tool to break down \
        multi-step work and track progress.

        WHEN TO USE:
        - Complex multi-step tasks (3+ distinct steps)
        - After receiving new instructions — immediately capture requirements as tasks
        - When starting work on a task — mark it as in_progress BEFORE beginning
        - After completing a task — mark completed and add follow-up tasks

        WHEN NOT TO USE:
        - Single, straightforward tasks
        - Trivial tasks where tracking adds no value

        ACTIONS: create, update, delete, list

        STATUS MACHINE: pending → in_progress → completed
        - Exactly ONE task can be in_progress at any time
        - Setting a task to in_progress automatically resets others to pending
        - Mark completed IMMEDIATELY when done — do NOT batch completions

        CONTENT FORMAT: Use imperative mood ("Fix auth bug"), not descriptive ("Auth bug fix")

        Each todo has: id, content, status (pending/in_progress/completed).
        """;
}
```

---

## 三、工具返回值行为反馈

### 现状

`TodoTool` 的所有 handler 返回值都是原始数据（todos 列表 + 简单 message），LLM 收到返回后只知道"数据变了"，不知道下一步该做什么。这是设计文档中强调的**最关键一层**。

### 改进

重写 `handleCreate`、`handleUpdate`、`handleList`，根据操作类型和状态转换嵌入行为指令：

```java
// TodoTool.java - handleCreate 重写
private String handleCreate(long sessionId, JsonNode items) throws Exception {
    int count = 0;
    if (items != null && items.isArray()) {
        for (JsonNode item : items) {
            SessionTodo todo = new SessionTodo();
            todo.setSessionId(sessionId);
            todo.setContent(item.has("content") ? item.get("content").asText() : "");
            todo.setStatus(item.has("status") ? item.get("status").asText() : "pending");
            sessionTodoMapper.insert(todo);
            count++;
        }
    }

    List<SessionTodo> todos = sessionTodoMapper.selectList(...);

    Map<String, Object> result = new LinkedHashMap<>();
    result.put("todos", todos);
    result.put("message", "Created " + count + " items");
    result.put("hint", "Tasks created. Begin working on the first pending task by marking it as in_progress.");
    return objectMapper.writeValueAsString(result);
}
```

```java
// TodoTool.java - handleUpdate 重写
private String handleUpdate(long sessionId, JsonNode items) throws Exception {
    boolean transitionedToCompleted = false;
    boolean transitionedToInProgress = false;
    List<String> updatedTaskSummaries = new ArrayList<>();

    if (items != null && items.isArray()) {
        for (JsonNode item : items) {
            long id = item.get("id").asLong();
            String newStatus = item.has("status") ? item.get("status").asText() : null;
            String newContent = item.has("content") ? item.get("content").asText() : null;

            // 单 in_progress 约束
            if ("in_progress".equals(newStatus)) {
                sessionTodoMapper.update(null,
                        new LambdaUpdateWrapper<SessionTodo>()
                                .eq(SessionTodo::getSessionId, sessionId)
                                .eq(SessionTodo::getStatus, "in_progress")
                                .ne(SessionTodo::getId, id)
                                .set(SessionTodo::getStatus, "pending"));
                transitionedToInProgress = true;
            }

            LambdaUpdateWrapper<SessionTodo> updateWrapper = new LambdaUpdateWrapper<SessionTodo>()
                    .eq(SessionTodo::getId, id)
                    .eq(SessionTodo::getSessionId, sessionId);
            if (newStatus != null) {
                updateWrapper.set(SessionTodo::getStatus, newStatus);
            }
            if (newContent != null) {
                updateWrapper.set(SessionTodo::getContent, newContent);
            }
            sessionTodoMapper.update(null, updateWrapper);

            if ("completed".equals(newStatus)) {
                transitionedToCompleted = true;
                updatedTaskSummaries.add(String.format("Updated task #%d to completed", id));
            }
        }
    }

    List<SessionTodo> todos = sessionTodoMapper.selectList(...);

    Map<String, Object> result = new LinkedHashMap<>();
    result.put("todos", todos);

    // 状态摘要
    if (!updatedTaskSummaries.isEmpty()) {
        result.put("summary", String.join(". ", updatedTaskSummaries));
    }

    // 行为指令嵌入
    if (transitionedToCompleted) {
        boolean allDone = todos.stream().allMatch(t -> "completed".equals(t.getStatus()));
        if (allDone && todos.size() >= 3) {
            boolean hasVerificationTask = todos.stream()
                    .anyMatch(t -> t.getContent().toLowerCase().contains("verif")
                            || t.getContent().contains("验证")
                            || t.getContent().contains("测试"));
            if (!hasVerificationTask) {
                result.put("hint", """
                        All tasks completed. None of them was a verification step.
                        Before writing your final summary, verify the work:
                        - Run relevant tests
                        - Check that the implementation matches requirements
                        - Create a verification task if needed
                        """);
            } else {
                result.put("hint", "All tasks completed. Review the todo list and write your final summary.");
            }
        } else {
            result.put("hint", "Task completed. Call todo list now to find your next available task.");
        }
    }

    return objectMapper.writeValueAsString(result);
}
```

```java
// TodoTool.java - handleList 重写
private String handleList(long sessionId) throws Exception {
    List<SessionTodo> todos = sessionTodoMapper.selectList(...);

    Map<String, Object> result = new LinkedHashMap<>();
    result.put("todos", todos);

    // 进度摘要
    long completedCount = todos.stream().filter(t -> "completed".equals(t.getStatus())).count();
    long inProgressCount = todos.stream().filter(t -> "in_progress".equals(t.getStatus())).count();
    result.put("progress", String.format("%d/%d completed, %d in progress",
            completedCount, todos.size(), inProgressCount));

    // 如果有进行中的任务，提醒继续
    if (inProgressCount > 0) {
        result.put("hint", "You have a task in progress. Continue working on it before starting another.");
    }

    return objectMapper.writeValueAsString(result);
}
```

**反馈策略矩阵**：

| 操作 | 状态转换 | 嵌入的反馈 |
|---|---|---|
| create | — | "Tasks created. Begin working on the first pending task." |
| update | → in_progress | 无额外提示 |
| update | → completed (非最后) | "Task completed. Call todo list now to find your next available task." |
| update | → completed (全部完成, >=3, 无验证任务) | "All tasks completed. Verify the work before writing final summary." |
| update | → completed (全部完成, >=3, 有验证任务) | "All tasks completed. Review the todo list and write your final summary." |
| delete | — | 无额外提示 |
| list | — | 进度摘要 + 如有 in_progress 任务则提醒继续 |

---

## 四、工具拆分策略

### 现状

当前是单一 `"todo"` 工具 + `action` 参数，与设计文档推荐的 4 个独立 CRUD 工具不一致。单一工具导致 LLM 需要在一次调用中决定 action + items，决策负担更高，且无法为不同 action 提供独立的详细 description。

### 改进

拆分为 4 个独立工具：`TaskCreateTool`、`TaskUpdateTool`、`TaskListTool`、`TaskDeleteTool`。

**Step 1 — 新增 4 个工具类**

```
backend/src/main/java/com/agentworkbench/harness/tool/impl/
├── TaskCreateTool.java    // 仅处理 create，description 聚焦创建场景
├── TaskUpdateTool.java    // 仅处理 update，description 聚焦状态转换规则
├── TaskListTool.java      // 仅处理 list，description 聚焦查看进度
└── TaskDeleteTool.java    // 仅处理 delete，description 聚焦清理场景
```

每个工具独立的 description，例如 `TaskUpdateTool`：

```java
@Override
public String getDescription() {
    return """
        Update the status or content of existing todo items.

        STATUS TRANSITIONS:
        - pending → in_progress: Start working on a task. Only ONE task can be in_progress.
          Setting a task to in_progress automatically resets all other in_progress tasks to pending.
        - in_progress → completed: Mark a task as done. Do this IMMEDIATELY after finishing.
          Do NOT batch multiple completions — mark each one as soon as it's done.

        IMPORTANT: Always mark tasks as completed one at a time, right after finishing each one.
        """;
}
```

**Step 2 — 删除旧 TodoTool**

移除 `TodoTool.java`，4 个新工具通过 Spring `@Component` 自动注册到 `ToolRegistry`。

**Step 3 — 适配 WsStreamingEventListener**

`WsStreamingEventListener.onToolCallResult()` 中的 todo 检测逻辑从单工具名改为多工具名：

```java
// WsStreamingEventListener.java
private static final Set<String> TODO_TOOLS = Set.of(
        "task_create", "task_update", "task_delete", "task_list");

@Override
public void onToolCallResult(String toolCallId, String result) {
    // ... existing logic ...

    if (TODO_TOOLS.contains(toolName)) {
        // 推送 todo_updated 事件（逻辑不变）
    }
}
```

**Step 4 — 适配前端路由**

`session.ts` 中跳过 todo 气泡的逻辑需适配多工具名：

```typescript
// session.ts - appendToolCallStart()
if (['task_create', 'task_update', 'task_delete', 'task_list'].includes(data.tool_name)) return
```

**Step 5 — PromptEngine system prompt 注入更新**

```java
// PromptEngine.java - appendToolBehaviorHints()
boolean hasTodoTool = context.getTools().stream()
        .anyMatch(t -> Set.of("task_create", "task_update", "task_list", "task_delete")
                .contains(t.getName()));
```

**Step 6 — Tool 接口 getToolPrompt() 各工具独立实现**

每个工具类覆写 `getToolPrompt()` 返回各自的行为指南 markdown 文件内容。

---

## 五、数据模型增强

### 现状

`session_todo` 表只有 `id`、`session_id`、`content`、`status`、`created_at`、`updated_at`，缺少任务详细描述、进行时描述、排序、多 Agent 归属等字段。

### 改进

新增迁移脚本 `V022__todo_schema_enhance.sql`：

```sql
-- V022: 增强 session_todo 表结构
ALTER TABLE `session_todo`
    ADD COLUMN `description` VARCHAR(4096) DEFAULT '' COMMENT '任务详细描述，供 Agent 深入理解任务上下文',
    ADD COLUMN `active_form` VARCHAR(256) DEFAULT '' COMMENT '进行时描述，如 Fixing auth bug',
    ADD COLUMN `sort_order` INT DEFAULT 0 COMMENT '排序序号，支持用户拖拽调整优先级',
    ADD COLUMN `owner` VARCHAR(128) DEFAULT NULL COMMENT '任务归属 Agent（多 Agent 场景）',
    ADD COLUMN `claimed_at` DATETIME DEFAULT NULL COMMENT '任务领取时间（多 Agent 场景）',
    ADD COLUMN `blocked_by` JSON DEFAULT NULL COMMENT '依赖的任务 ID 列表，形成 DAG 阻塞关系';
```

同步更新 `SessionTodo` 实体：

```java
@Data
@TableName("session_todo")
public class SessionTodo {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long sessionId;
    private String content;
    private String description;
    private String activeForm;
    private String status;
    private Integer sortOrder;
    private String owner;
    private LocalDateTime claimedAt;
    private String blockedBy;  // JSON array of task IDs
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
```

同步更新各 Tool 的 input schema，增加 `description`、`active_form`、`sort_order`、`blocked_by` 字段的定义。

---

## 六、UI 层增强

### 现状

`TodoChecklist.vue` 已实现基础的状态图标和进度条，`session.ts` 已实现跳过 todo 工具气泡。但缺少：已完成任务删除线效果不够明显、进行中任务缺少加粗强调、用户无法手动操作 todo 状态。

### 改进

**6.1 视觉反馈增强**

修改 [TodoChecklist.vue](desktop/src/components/task/TodoChecklist.vue)：

```vue
<template>
  <div class="todo-checklist">
    <div v-if="!todos || todos.length === 0" class="todo-empty">
      暂无任务清单
    </div>
    <template v-else>
      <div class="todo-summary">
        <span class="todo-progress-text">{{ completedCount }}/{{ todos.length }} 已完成</span>
        <div class="todo-progress-bar">
          <div class="todo-progress-fill" :style="{ width: progressPercent + '%' }"></div>
        </div>
      </div>
      <div class="todo-list">
        <div
          v-for="item in todos"
          :key="item.id"
          class="todo-item"
          :class="`status-${item.status}`"
        >
          <span class="todo-icon">
            <el-icon v-if="item.status === 'completed'" :size="14" class="icon-done"><Select /></el-icon>
            <span v-else-if="item.status === 'in_progress'" class="icon-active"></span>
            <span v-else class="icon-pending"></span>
          </span>
          <span class="todo-content">{{ item.content }}</span>
          <span class="todo-actions" v-if="editable">
            <el-dropdown trigger="click" @command="(cmd: string) => handleAction(cmd, item)">
              <el-icon class="action-trigger"><MoreFilled /></el-icon>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item v-if="item.status !== 'in_progress'" command="start">
                    标记为进行中
                  </el-dropdown-item>
                  <el-dropdown-item v-if="item.status !== 'completed'" command="complete">
                    标记为已完成
                  </el-dropdown-item>
                  <el-dropdown-item command="delete" divided>
                    删除
                  </el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </span>
        </div>
      </div>
    </template>
  </div>
</template>
```

对应 CSS 增强：

```css
/* 已完成：删除线 + 降低对比度 */
.todo-item.status-completed .todo-content {
  text-decoration: line-through;
  opacity: 0.55;
}

/* 进行中：加粗 + 高亮背景 + 左侧强调线 */
.todo-item.status-in_progress {
  font-weight: 600;
  background: var(--el-color-primary-light-9);
  border-left: 3px solid var(--el-color-primary);
  padding-left: 8px;
}

/* 待处理：正常样式 */
.todo-item.status-pending .todo-content {
  opacity: 0.8;
}
```

**6.2 用户手动操作**

新增 props `editable` 和事件 `@update`：

```typescript
// TodoChecklist.vue script
const props = defineProps<{
  todos?: TodoItem[]
  editable?: boolean
}>()

const emit = defineEmits<{
  (e: 'update', todoId: number, action: 'start' | 'complete' | 'delete'): void
}>()

function handleAction(cmd: string, item: TodoItem) {
  emit('update', item.id, cmd as 'start' | 'complete' | 'delete')
}
```

**6.3 用户操作 API**

新增 REST 接口支持用户手动更新 todo 状态：

```java
// SessionController.java
@PatchMapping("/{sessionId}/todos/{todoId}")
public Result<Void> updateTodo(
        @AuthenticationPrincipal Long userId,
        @PathVariable Long sessionId,
        @PathVariable Long todoId,
        @RequestBody TodoUpdateRequest request) {
    // 更新 todo 状态
    // 同时推 WebSocket todo_updated 事件
}
```

**6.4 前端 composable 对接**

在 `useChat.ts` 中新增手动更新方法：

```typescript
async function updateTodoManually(sessionId: string, todoId: number, action: string) {
  const statusMap: Record<string, string> = {
    start: 'in_progress',
    complete: 'completed',
    delete: 'deleted'
  }
  if (action === 'delete') {
    await api.delete(`/sessions/${sessionId}/todos/${todoId}`)
  } else {
    await api.patch(`/sessions/${sessionId}/todos/${todoId}`, { status: statusMap[action] })
  }
}
```

---

## 七、代码清理

### AgentLoop 残留注释

[AgentLoop.java:213](backend/src/main/java/com/agentworkbench/harness/core/AgentLoop.java#L213) 的 Javadoc 写的是 "Returns true if any tool call was to the 'todo' skill"，但方法签名已改为 `void`，且 "todo skill" 是旧称。清理为：

```java
/**
 * Execute tool calls in parallel using CompletableFuture.
 */
private void executeToolCalls(List<ChatRequest.ToolCall> pendingCalls,
```

### ToolResultSummarizer 适配

[ToolResultSummarizer.java](backend/src/main/java/com/agentworkbench/session/util/ToolResultSummarizer.java) 需要适配新的 4 个工具名，为 `task_create`、`task_update`、`task_delete`、`task_list` 提供人类可读的摘要逻辑。

---

## 改动文件清单

| 文件 | 改动类型 | 说明 |
|---|---|---|
| `PromptEngine.java` | 修改 | 新增 `appendToolBehaviorHints()` + `appendToolPrompts()` |
| `Tool.java` | 修改 | 新增 `default String getToolPrompt()` |
| `TodoTool.java` | 删除 | 拆分为 4 个独立工具 |
| `TaskCreateTool.java` | 新增 | create 工具 |
| `TaskUpdateTool.java` | 新增 | update 工具，含行为反馈 + 验证提醒 |
| `TaskListTool.java` | 新增 | list 工具，含进度摘要 |
| `TaskDeleteTool.java` | 新增 | delete 工具 |
| `prompts/todo-tool-prompt.md` | 新增 | 完整的 todo 行为指南（few-shot 示例、触发条件等） |
| `prompts/task-create-prompt.md` | 新增 | TaskCreate 行为指南 |
| `prompts/task-update-prompt.md` | 新增 | TaskUpdate 行为指南 |
| `prompts/task-list-prompt.md` | 新增 | TaskList 行为指南 |
| `prompts/task-delete-prompt.md` | 新增 | TaskDelete 行为指南 |
| `V022__todo_schema_enhance.sql` | 新增 | 数据库迁移：增加 description、active_form、sort_order、owner、claimed_at、blocked_by |
| `SessionTodo.java` | 修改 | 实体字段与迁移同步 |
| `AgentLoop.java` | 修改 | 清理 L213 过时注释 |
| `WsStreamingEventListener.java` | 修改 | todo 检测从单工具名改为多工具名集合 |
| `ToolResultSummarizer.java` | 修改 | 适配新工具名的摘要逻辑 |
| `SessionController.java` | 修改 | 新增 `PATCH /{sessionId}/todos/{todoId}` 接口 |
| `TodoChecklist.vue` | 修改 | 视觉增强 + 用户操作支持 |
| `session.ts` | 修改 | todo 气泡跳过逻辑适配多工具名 |
| `useChat.ts` | 修改 | 新增 `updateTodoManually()` |
| `useStreamWS.ts` | 确认 | `todo_updated` 事件路由无需改动（事件名不变） |

---

## 预期效果

改进完成后，Agent 的 todo 使用行为将从"偶尔想起来用一下"变为"系统性地分解和跟踪任务"：

1. **知道要用** — System prompt 每轮提醒，消除"忘记使用 todo"的问题
2. **用得对** — Tool prompt 行为规范 + few-shot 示例，消除"在不该用时滥用"和"格式不对"的问题
3. **持续推进** — 返回值行为反馈嵌入下一步指令，消除"做完不标记"和"攒批更新"的问题
4. **验证闭环** — 全部完成时自动提醒验证，消除"跳过验证直接下结论"的问题
5. **用户可控** — 用户可手动调整 todo 状态和优先级，形成外部监督
