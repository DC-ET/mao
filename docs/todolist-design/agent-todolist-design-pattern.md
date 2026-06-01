# AI Agent TODO List 能力集成设计模式

> 基于 Claude Code Task Tools 实现提炼，可复用于任何需要"任务驱动工作流"的 AI Agent 系统。

---

## 1. 核心问题

Agent 天然缺乏"记住自己在做什么"的能力。面对多步骤任务时，常见的失败模式有：

- **遗忘**：做到一半忘了还有哪些步骤没完成
- **跳步**：跳过中间步骤直接给结论
- **不闭环**：完成了工作但忘记标记状态，用户看不到进度
- **攒批**：一口气做完所有事才更新状态，中间过程不透明

Task Tools 的设计目标就是通过**系统性的机制**（而非依赖模型自觉）来消除这些问题。

---

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                     System Prompt                            │
│  "用 TaskCreate 管理工作，完成立即标记，不要攒批"              │
│                              │                               │
│                              ▼                               │
│  ┌──────────────────────────────────────────────────────┐    │
│  │              Tool Layer (4 个 CRUD 工具)              │    │
│  │  TaskCreate │ TaskGet │ TaskUpdate │ TaskList        │    │
│  │                                                      │    │
│  │  每个工具内含:                                        │    │
│  │  · prompt (行为规范 + few-shot 示例)                  │    │
│  │  · call  (业务逻辑)                                   │    │
│  │  · mapToolResultToToolResultBlockParam (反馈闭环)     │    │
│  └──────────────┬───────────────────────────────────────┘    │
│                 │                                            │
│                 ▼                                            │
│  ┌──────────────────────────────────────────────────────┐    │
│  │              Storage Layer                            │    │
│  │  文件系统持久化 + 文件锁                              │    │
│  │  $CODEX_HOME/tasks/<taskListId>/<taskId>.json         │    │
│  └──────────────────────────────────────────────────────┘    │
│                 │                                            │
│                 ▼                                            │
│  ┌──────────────────────────────────────────────────────┐    │
│  │              Watcher Layer                            │    │
│  │  fs.watch 监听 → 自动发现 → 领取 → 提交为 prompt     │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐    │
│  │              UI Layer                                 │    │
│  │  终端实时渲染任务列表，用户可见进度                    │    │
│  └──────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 四层行为塑造机制

### 3.1 第一层：System Prompt 注入——让 Agent "知道"

**目标**：在每轮推理的上下文中植入行为指令，确保 Agent 从第一轮就知道要用任务工具。

**实现方式**：在构建 system prompt 时，根据当前启用的工具集动态插入指令：

```
Break down and manage your work with the TaskCreate tool.
These tools are helpful for planning your work and helping the user track your progress.
Mark each task as completed as soon as you are done with the task.
Do not batch up multiple tasks before marking them as completed.
```

**关键设计点**：

| 要素 | 说明 |
|------|------|
| 动态工具名 | 根据 enabledTools 集合选择引用对应的任务工具名称，与实际可用工具保持一致 |
| 位置 | 放在 "Using your tools" 章节，与其他工具使用规范并列，权重等同于"不要用 Bash 替代专用工具" |
| 指令强度 | 使用祈使句 + "CRITICAL" 级别强调，而非建议性措辞 |

**为什么有效**：System prompt 是模型每轮推理都会读取的上下文。把它放在这里，等同于"每次开会前先读一遍会议纪律"——频率保证了记忆。

---

### 3.2 第二层：Tool Prompt——教 Agent "怎么做"

**目标**：当 Agent 决定调用某个工具时，提供足够详细的行为规范，让它"做对"。

每个工具都有独立的 prompt 文件，包含以下结构：

#### (a) 触发条件（When to Use / When NOT to Use）

```markdown
## When to Use This Tool
- Complex multi-step tasks - When a task requires 3 or more distinct steps
- After receiving new instructions - Immediately capture user requirements as tasks
- When you start working on a task - Mark it as in_progress BEFORE beginning work
- After completing a task - Mark it as completed and add new follow-up tasks

## When NOT to Use This Tool
- There is only a single, straightforward task
- The task is trivial and tracking it provides no organizational benefit
```

**设计意图**：正向 + 反向规则并存，既告诉 Agent "什么情况该用"，也防止它在不该用的时候滥用（比如回答一个简单问题也要建任务列表）。

#### (b) 状态机约束

```
Status progresses: pending → in_progress → completed
Use `deleted` to permanently remove a task.
```

配合隐含约束：任意时刻**恰好 1 个** in_progress 任务。

#### (c) Few-shot 示例

提供正确使用和不正确使用的对比示例，让模型通过类比学习：

```markdown
<example>
User: I want to add a dark mode toggle...
Assistant: *Creates todo list with 5 items*
*Begins working on the first task*

<reasoning>
The assistant used the todo list because:
1. Adding dark mode is a multi-step feature
2. The user explicitly requested tests and build
</reasoning>
</example>
```

#### (d) 字段规范

明确每个字段的语义和格式要求：

- `subject`：命令式（"Fix authentication bug"）
- `activeForm`：进行时（"Fixing authentication bug"）
- `description`：足够详细，让其他 Agent 也能理解和执行

**为什么有效**：Tool prompt 只在模型调用该工具时加载，不占用不相关推理的上下文。它是"按需加载的操作手册"。

---

### 3.3 第三层：工具返回值反馈——推 Agent "继续做"

**这是整个设计中最关键的一层**。工具的 `mapToolResultToToolResultBlockParam` 方法控制返回给模型的文本，而这段文本本身就是下一轮推理的输入——形成了**行为闭环**。

#### (a) 常规反馈：强化使用习惯

每次 TaskUpdate 调用成功后，返回：

```
Updated task #1 status, subject
```

简洁、明确，让模型知道操作已生效。

#### (b) 状态转换时的下一步指令

当 teammate agent 完成一个任务时（[TaskUpdateTool.ts:387-393](src/tools/TaskUpdateTool/TaskUpdateTool.ts#L387-L393)）：

```typescript
if (statusChange?.to === 'completed' && getAgentId() && isAgentSwarmsEnabled()) {
  resultContent += '\n\nTask completed. Call TaskList now to find your next available task or see if your work unblocked others.'
}
```

**设计精妙之处**：不是在 system prompt 里泛泛地说"完成后要找下一个任务"，而是在**完成动作发生的那一刻**，通过工具返回值精确地告诉 Agent "现在就去调 TaskList"。时机 + 指令的组合，比泛化指令有效得多。

#### (c) 验证提醒（Verification Nudge）

当所有任务完成时（[TaskUpdateTool.ts:333-349](src/tools/TaskUpdateTool/TaskUpdateTool.ts#L333-L349)）：

```typescript
if (allDone && allTasks.length >= 3 && !allTasks.some(t => /verif/i.test(t.subject))) {
  verificationNudgeNeeded = true
}
// ...
resultContent += `\n\nNOTE: You just closed out 3+ tasks and none of them was a verification step.
Before writing your final summary, spawn the verification agent...`
```

**触发时机**：精确在"最后一个任务被标记为 completed"的那一刻。这是 Agent 最容易"觉得工作做完了"就退出循环的时刻，也是最需要提醒它做验证的时刻。

**为什么有效**：工具返回值是模型**必须处理**的上下文。它不像 system prompt 那样可能被"习惯性忽略"——每次工具调用的返回都是一个新的、需要被理解的输入。把行为指令嵌入返回值，等于在 Agent 的"必经之路"上设了路标。

---

### 3.4 第四层：UI + Watcher——外部可见性与自动驱动

#### (a) UI 渲染（TaskListV2 组件）

任务列表直接渲染在终端界面中：

- ✓ 已完成（删除线）
- ■ 进行中（加粗）
- □ 待处理

**作用**：形成**外部监督**。如果 Agent 不更新状态，用户可以立即看到不一致——进度条不动但 Agent 声称已完成。这种"可被观测性"反过来约束了 Agent 的行为。

#### (b) 自动任务领取（useTaskListWatcher）

```typescript
// 核心循环
watcher = watch(tasksDir, debouncedCheck)  // 监听文件系统
// → findAvailableTask(tasks)              // 找 pending + 无 owner + 未阻塞的任务
// → claimTask(taskListId, taskId, agentId) // 原子抢占
// → formatTaskAsPrompt(task)              // 格式化为 prompt
// → onSubmitTask(prompt)                  // 提交给 Agent 执行
```

**关键特性**：
- `fs.watch` 实时监听，任务一创建就触发
- 1 秒防抖，避免文件批量写入时重复触发
- `claimTask` 原子操作，防止多 Agent 重复领取
- 只在 `isLoading === false`（Agent 空闲）时提交

**为什么有效**：Agent 甚至不需要主动查找任务——系统把可用任务"推"到它面前。这消除了"忘记检查新任务"的可能性。

---

## 4. 工具拆分策略

将任务管理拆分为**四个职责单一的 CRUD 工具**：

| 工具 | 职责 |
|---|---|
| `TaskCreate` | 创建任务 |
| `TaskGet` | 查询任务详情 |
| `TaskUpdate` | 更新任务状态/字段 |
| `TaskList` | 列出所有任务摘要 |

### 4.1 拆分的好处

**降低单次调用的复杂度**：每次只操作一个任务，模型不需要在一次调用中决定所有任务的状态，决策负担大幅降低。

**更精确的反馈**：TaskUpdate 可以精确返回"任务 #3 的 status 从 in_progress 变为 completed"，甚至在完成时推送下一步指令。

**支持依赖关系**：blocks / blockedBy 让任务之间形成 DAG，Agent 可以按拓扑序执行，避免在被阻塞的任务上浪费时间。

### 4.2 四个工具的协作流程

```
用户: "帮我实现用户注册、产品目录、购物车、结账流程"

Agent 思考 → 调用 TaskCreate ×4
  TaskCreate({ subject: "实现用户注册", description: "..." })
  TaskCreate({ subject: "实现产品目录", description: "..." })
  TaskCreate({ subject: "实现购物车",   description: "..." })
  TaskCreate({ subject: "实现结账流程", description: "...", addBlockedBy: ["3"] })
                                         ↑ 结账依赖购物车

Agent 调用 TaskList → 查看全貌
  → 找到 #1 未阻塞，开始工作

Agent 调用 TaskUpdate({ taskId: "1", status: "in_progress" })
  → 返回: "Updated task #1 status"
  → [Agent 执行实现代码]

Agent 调用 TaskUpdate({ taskId: "1", status: "completed" })
  → 返回: "Updated task #1 status\nTask completed. Call TaskList now to find your next available task."
  → [Agent 被推着去调 TaskList]

Agent 调用 TaskList → #2 可用，继续
  → ... 循环直到全部完成
```

---

## 5. 多 Agent 协作支持

文件持久化天然支持多 Agent 场景：

### 5.1 任务抢占

```typescript
const result = await claimTask(taskListId, availableTask.id, agentId)
// claimTask 内部用文件锁保证原子性，防止两个 Agent 同时领取同一任务
```

### 5.2 归属自动设置

当 Agent 将任务标记为 in_progress 时，自动设置 owner：

```typescript
if (status === 'in_progress' && owner === undefined && !existingTask.owner) {
  const agentName = getAgentName()
  if (agentName) {
    updates.owner = agentName
  }
}
```

### 5.3 依赖阻塞

`blockedBy` 中有未完成的任务时，该任务不会被 Watcher 自动领取：

```typescript
function findAvailableTask(tasks: Task[]): Task | undefined {
  const unresolvedTaskIds = new Set(
    tasks.filter(t => t.status !== 'completed').map(t => t.id),
  )
  return tasks.find(task => {
    if (task.status !== 'pending') return false
    if (task.owner) return false
    return task.blockedBy.every(id => !unresolvedTaskIds.has(id))
  })
}
```

---

## 6. 可复用的设计原则

从实现中提炼出以下通用原则，适用于任何 Agent 任务管理系统：

### 原则 1：System Prompt 植入 + Tool Prompt 详解

- System prompt 只放**一句话指令**（"用 X 工具管理你的工作"）
- Tool prompt 放**完整行为规范**（触发条件、状态机、示例）
- 两者分工：前者保证频率，后者保证深度

### 原则 2：工具返回值即行为指令

- 不要只返回操作结果（"已更新"）
- 在返回值中嵌入**下一步动作**（"现在去查任务列表"）
- 在关键退出点（所有任务完成）加入**安全检查**（"记得做验证"）

### 原则 3：任务状态转换是最佳干预点

- `pending → in_progress`：确认 Agent 真的开始做了
- `in_progress → completed`：推送下一步或安全检查
- 每次状态转换都是一个"自然的对话节点"，比泛化提醒更有效

### 原则 4：外部可见性形成约束

- 任务列表对用户可见 → Agent 不更新状态会被发现
- 进度条/状态图标提供即时反馈 → 用户可以介入纠正

### 原则 5：推优于拉

- Watcher 自动发现并推送任务，而非让 Agent 主动查找
- 减少 Agent "忘记检查"的可能性

### 原则 6：单任务粒度优于全量更新

- 每次只操作一个任务，降低模型决策负担
- 精确的返回值反馈，而非"列表已更新"的模糊确认

---

## 7. 实现清单

如果要在自己的 Agent 系统中复用这套模式，需要实现以下组件：

### 必需组件

- [ ] **Task Schema**：id, subject, description, status, owner, blocks, blockedBy
- [ ] **TaskCreate Tool**：创建任务，prompt 包含触发条件和字段说明
- [ ] **TaskUpdate Tool**：更新状态，在返回值中嵌入下一步指令
- [ ] **TaskList Tool**：列出所有任务，返回摘要
- [ ] **TaskGet Tool**：获取单个任务详情
- [ ] **System Prompt 注入**：在系统提示词中加入一句话任务管理指令
- [ ] **Storage Layer**：任务持久化（文件系统或数据库）

### 增强组件

- [ ] **Tool Result Feedback**：在 mapToolResult 中根据状态转换嵌入不同反馈
- [ ] **Verification Nudge**：所有任务完成时的验证提醒
- [ ] **Task Watcher**：文件系统监听 + 自动领取
- [ ] **UI Rendering**：终端任务列表渲染
- [ ] **Multi-Agent Support**：claim 原子操作 + owner 自动设置
- [ ] **Dependency Graph**：blocks / blockedBy 阻塞关系

---

## 8. 参考实现文件

| 组件 | 文件路径 |
|------|---------|
| 工具注册 | `src/tools.ts` (L208-219) |
| System Prompt | `src/constants/prompts.ts` (L269-313) |
| TaskCreate | `src/tools/TaskCreateTool/TaskCreateTool.ts` |
| TaskCreate Prompt | `src/tools/TaskCreateTool/prompt.ts` |
| TaskUpdate | `src/tools/TaskUpdateTool/TaskUpdateTool.ts` |
| TaskUpdate Prompt | `src/tools/TaskUpdateTool/prompt.ts` |
| TaskList | `src/tools/TaskListTool/TaskListTool.ts` |
| TaskGet | `src/tools/TaskGetTool/TaskGetTool.ts` |
| Storage + CRUD | `src/utils/tasks.ts` |
| Task Watcher | `src/hooks/useTaskListWatcher.ts` |
| UI 组件 | `src/components/TaskListV2.tsx` |
