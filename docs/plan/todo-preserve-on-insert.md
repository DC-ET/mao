# 纠偏消息保留任务清单（todo）技术方案

## 背景与问题

Agent 在收到消息并拆解任务（写入 `session_todo`）后开始执行。当前实现中，**每次执行前都会清空上一轮的 todo**（`StreamingWsHandler` 内 `sessionTodoMapper.delete(...)`）。

这一"整轮清空"逻辑带来两类问题：

1. **Agent 漏标状态**：Agent 执行时常漏更新部分 task 的 `completed`，导致任务跑完后 todolist 里零散挂着未完成任务，困扰用户。
2. **列表随轮数膨胀**：若不清空，会话多轮后 todo 无限累积，旧任务与当前轮已无关联。

因此最初选择"每次新消息清空"，但引发新痛点：

- **纠偏丢目标**：用户在执行中途通过队列「立即发送」插入补充/纠偏消息打断当前任务时，todo 被清空，Agent 失去上一轮已拆解的目标与进度，后续工作失去明确方向。而多数纠偏只是补充信息，对核心目标影响很小。

## 队列的产品语义（关键前提）

队列设计目的：Agent 执行慢、用户待办多，用户可预先把多个任务排入队列，Agent 依次自动执行，用户无需守屏。

由此得出消息触发的语义区分：

| 触发方式 | 入口 | 语义 | 是否清空 todo |
|---------|------|------|--------------|
| 直接发消息（空闲时） | `send_message` | 开启新任务 | **清空** |
| 队列正常消费 | `autoConsumeQueue` | 上一任务完成 → 开始下一个新任务 | **清空** |
| 编辑并重发 | `edit_and_resend` | 新消息（推翻重写） | **清空** |
| 立即发送打断 | `insert_message` | 任务进行中插入补充/纠偏，打断当前任务 | **不清空** |
| 宕机重启恢复 | `CrashRecoveryRunner` | 同一轮重入 | **不清空**（本就无 delete） |

核心原则：**清空 = 新任务开始；不清空 = 打断中的纠偏**。

- 正常消费 = 「任务完成后用户发送新消息」，与直接发新消息等价 → 清空。
- 只有「立即发送打断」是纠偏 → 不清空，Agent 下一轮 `task_list` 仍看得到完整进度树，目标不丢。

## 改动方案

**不动表结构、不动 Prompt、不动 `AgentLoop` / `HarnessService` / task 工具。** 仅调整 `StreamingWsHandler` 中 `delete` 的触发条件。

### 改动点（`backend/.../session/ws/StreamingWsHandler.java`）

1. **`handleSendMessage` 增加 `boolean clearTodos` 参数**（默认值保持 `true` 向后兼容）。
   将原有 `delete` 段（`// Clear previous turn's todos ...`）包入 `if (clearTodos) { ... }`。

2. **`handleInsertMessage`（立即发送打断）**：构造 `syntheticRoot` 时写入 `data.clearTodos = false`，并以 `handleSendMessage(userId, syntheticRoot, false)` 调用 → 纠偏不清空 todo。

3. **其余调用点保持 `clearTodos = true`**：
   - `send_message` 直接调用（`:235`）
   - `autoConsumeQueue` 内调用（`:589`）
   - `handleEditAndResend`（`:743`）维持自身 `delete`（算新消息）

4. **`CrashRecoveryRunner`** 无需改动（恢复路径本就无 `delete`）。

### 效果对照

| 痛点 | 结果 |
|------|------|
| 纠偏丢目标 | ✅ `insert_message` 不打断清空，进度树保留 |
| 列表随轮膨胀 | ✅ 直接发 / 编辑重发 / 正常消费仍清空，旧 todo 不累积 |
| Agent 漏标脏 | 维持现状：新任务场景整轮清空兜底；纠偏场景不清（如需可后续对残留 `in_progress` 轻量收口，非必需） |

## 验证建议

- 场景 A（纠偏保留）：Agent 执行中，队列中消息「立即发送」打断 → 检查 `session_todo` 未被删除，前端 `todo_updated` 未收到空列表，Agent 续跑时 `task_list` 可见旧任务。
- 场景 B（新任务清空）：空闲时直接发新消息 / 队列正常消费下一条 → 检查 `session_todo` 被清空，前端收到空 `todo_updated`。
- 场景 C（恢复保留）：执行中重启 → `CrashRecoveryRunner` 恢复，todo 原样保留（既有行为，不受影响）。
