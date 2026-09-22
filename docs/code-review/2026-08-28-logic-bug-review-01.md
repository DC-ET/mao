# 项目核心功能逻辑 BUG 审查报告

> 审查日期：2026-08-28
> 审查范围：backend-ts（核心服务层）、harness（Agent 引擎与工具）、schedule（定时任务）、desktop（Electron 前端）
> 共发现 6 个核心功能逻辑 BUG，按严重程度与模块分布如下。

---

## BUG #1 — `WriteFileTool` 的 `total_lines` 计算未处理尾部换行（数据不一致）

**文件**：`backend-ts/src/harness/tool/impl/write-file-tool.ts:58`
**严重程度**：🟡 中（行数统计错误）

**问题代码**：

```ts
const newLineCount = content === '' ? 0 : content.split('\n').length;
```

**根因分析**：

当文件内容以换行符结尾时（如 `"line1\nline2\n"`），`String.prototype.split('\n')` 会多产生一个空字符串元素：

- `"line1\nline2".split('\n')` → `['line1', 'line2']`（长度 2）✅
- `"line1\nline2\n".split('\n')` → `['line1', 'line2', '']`（长度 3）❌

而同项目的 `read-file-tool.ts` 中 `splitLines()` 函数正确处理了此情况：

```ts
function splitLines(raw: string): string[] {
  if (raw === '') return [];
  const lines = raw.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === '') lines.pop(); // ← 移除尾部空行
  return lines;
}
```

`write_file` 返回的 `total_lines` 比实际行数多 1（当内容以换行结尾时），导致 `file_change` 记录的行数信息失真，可能影响下游的文件变更统计与 UI 展示。

**修复建议**：

```ts
const newLineCount = content === '' ? 0 : content.split('\n').filter(Boolean).length;
// 或更严谨地：
const newLineCount = content === '' ? 0 : content.split(/\r\n|\r|\n/).filter(l => l !== '').length;
```

---

## BUG #2 — `TaskUpdateTool` 传递可能为 `NaN` 的 `id` 给 `resetInProgress`（静默失败）

**文件**：`backend-ts/src/harness/tool/impl/task-tools.ts:175`
**严重程度**：🟡 中（待办事项状态流转静默失败）

**问题代码**：

```ts
for (const item of items) {
    const id = Number(item.id);       // 若 item.id 为 undefined → NaN
    const newStatus = asText(item.status);
    if (newStatus === 'in_progress' && sessionId != null) {
      await this.sessionTodoMapper.resetInProgress(sessionId, id); // id 可能为 NaN
    }
```

**根因分析**：

`Number(undefined)` 返回 `NaN`。当调用方传入的 `items` 中某项缺少 `id` 字段时：

1. `resetInProgress(sessionId, NaN)` 被调用，`exceptId` 参数为 `NaN`。
2. 在 `SessionTodoMapper.resetInProgress` 中，`exceptId != null` 为 `true`（`NaN != null` 在 JS 中为 `true`）。
3. 执行 SQL：`UPDATE session_todo SET status = 'pending' WHERE session_id = ? AND status = 'in_progress' AND id <> NaN`。
4. 在 SQL 中，`id <> NaN` 永远为 `NULL`（未知），因此 **没有任何行会被更新**。
5. 结果：`in_progress` 状态未被重置，其他待办事项无法被正确处理，状态流转静默失败。

对比 `TaskCreateTool` 中的调用（安全）：

```ts
if (status === 'in_progress' && sessionId != null) {
    await this.sessionTodoMapper.resetInProgress(sessionId);  // 只传 sessionId
}
```

**修复建议**：

```ts
const id = Number(item.id);
if (!Number.isFinite(id)) {
  return errorJson(`无效的待办事项 ID: ${item.id}`);
}
```

---

## BUG #3 — `lineAt` 计算了 `lineEnd` 但未使用，行预览文本截断不完整（UI 展示错误）

**文件**：`backend-ts/src/harness/tool/impl/edit-file-match.ts:68-73`
**严重程度**：🟡 中（代码预览展示不完整）

**问题代码**：

```ts
function lineAt(content: string, index: number): { lineNumber: number; lineText: string } {
  let lineNumber = 1;
  let lineStart = 0;
  for (let i = 0; i < index; i++) {
    if (content[i] === '\n') {
      lineNumber++;
      lineStart = i + 1;
    }
  }
  let lineEnd = content.indexOf('\n', index);  // ← 计算了但未使用
  if (lineEnd === -1) lineEnd = content.length;
  let lineText = content.slice(lineStart, index);  // ← 应使用 lineEnd 而非 index
  if (lineText.endsWith('\r')) lineText = lineText.slice(0, -1);
  return { lineNumber, lineText };
}
```

**根因分析**：

`lineEnd` 变量被计算出来（`content.indexOf('\n', index)` 或 `content.length`），但后续 `lineText` 的切片使用的是 `content.slice(lineStart, index)`，只截取了从行首到 `old_string` 出现位置之前的文本，而非整行文本。

该函数被 `formatAmbiguousMatchError` 调用，用于在编辑冲突时展示出现位置：

```ts
const previews: string[] = [];
for (let i = 0; i < previewCount; i++) {
    const { lineNumber, lineText } = lineAt(content, starts[i]);
    previews.push(`  第 ${lineNumber} 行: ${truncatePreview(lineText)}`);
}
```

由于 `lineText` 仅为行首到 `old_string` 之间的片段，预览展示不完整，用户无法看到 `old_string` 之后的行内容，给定位上下文判断带来困扰。`lineEnd` 变量属于死代码（dead code）。

**修复建议**：

```ts
let lineText = content.slice(lineStart, lineEnd);
```

---

## BUG #4 — `executeToolCalls` 多工具并行路径缺少开始前取消检查，且并发写存在竞态（AgentLoop）

**文件**：`backend-ts/src/harness/core/agent-loop.ts:488-505`
**严重程度**：🟡 中（取消失效 + 并发副作用无序）

**问题代码**：

```ts
if (pendingCalls.length === 1) {
  if (cancelFlag?.get()) return;               // ← 单工具：执行前检查取消
  const tc = pendingCalls[0];
  const rawResult = await runOne(tc);
  const toolSave = this.processToolResult(rawResult, tc, context);
  if (cancelFlag?.get()) return;               // ← 单工具：执行后二次检查
  ...
}

const results = await Promise.all(pendingCalls.map((tc) => runOne(tc)));  // ← 多工具：无执行前检查
if (cancelFlag?.get()) return;                 // ← 只有 Promise.all 全部结束后才检查
```

**根因分析**：

`executeToolCalls` 对"单工具调用"与"多工具调用"两条路径的取消处理不一致：

1. **取消检查缺失**：单工具路径在 `runOne` 执行**之前**会先检查 `cancelFlag`，命中即提前返回，不执行工具；而多工具路径（`pendingCalls.length > 1`）没有任何执行前检查，直接 `Promise.all` 启动全部工具。当用户点击"停止/取消"（`requestCancel` 已置位 `cancelFlag`）而本轮 LLM 恰好返回多个 tool_calls 时，**所有 pending 工具仍会全部执行完**，取消请求在该轮内完全失效——这与单工具路径可即时中止的行为不一致，且多个工具（如 `shell exec`）的副作用会在取消后继续产生。

2. **并发写竞态**：多工具使用 `Promise.all` 并发执行。当并行返回多个写类工具（`edit_file`、`write_file` 等）时，若它们操作同一文件/同一工作区，存在 read-modify-write 竞态——两个工具读取同一旧内容、各自修改后写入，后写入者覆盖先写入者的修改，导致 Agent 的文件改动部分丢失且无任何串行化或互斥保护；工具间的副作用完成顺序也与工具调用顺序无关（`pendingToolSaves`/`toolResults` 的登记顺序虽是确定的，但文件系统副作用交错）。

**修复建议**：

```ts
if (cancelFlag?.get()) return;                                  // 多工具路径补充执行前检查
const results = await Promise.all(pendingCalls.map((tc) => runOne(tc)));
if (cancelFlag?.get()) return;
```

对写类工具（文件/工作区变更）可进一步考虑串行执行或文件级互斥，避免并发读写竞态。

---

## BUG #5 — 定时任务因会话忙碌被入队（QUEUED）时仍累计 `fireCount` / 刷新 `lastFireTime`（执行统计失真）

**文件**：`backend-ts/src/schedule/scheduled-task.service.ts:229-231, 263-272`
**严重程度**：🟡 中（执行统计与事实不符）

**问题代码**：

```ts
if (busy) {
  await this.messageQueueService.enqueue(task.sessionId!, userId, task.prompt!, null);  // 仅入队
  await this.markTaskResult(task, 'QUEUED');   // lastExecutionStatus = 'QUEUED'
  countThisRun = true;                          // ← 标记"本轮计入"
  return;
}
...
} finally {
  if (!countThisRun) return;
  task.lastFireTime = formatDateTime(new Date());          // ← 入队即刷新"最后执行时间"
  task.fireCount = (task.fireCount ?? 0) + 1;              // ← 入队即累加"执行次数"
  if (task.lastExecutionStatus !== 'QUEUED' && ...) { ... }
  await this.store.updateById(task);
}
```

**根因分析**：

当定时任务触发时若对应会话正忙（`isSessionBusy` 或 `phase` 处于活跃态），当前逻辑的处理是：把 prompt 压入消息队列等待**稍后补执行**，`lastExecutionStatus` 记为 `QUEUED`（"未执行、已排队"）。但该分支把 `countThisRun` 置为 `true`，进入 `finally` 后：

1. `lastFireTime` 被刷新为"入队时间"——而任务真正执行发生在之后消息队列消费时，`lastFireTime` 与实际执行时间不符；
2. `fireCount`（对外展示的"已执行次数"）被 +1——但本轮任务**并未真正执行**，真正执行的那一轮又发生在消息队列链路中，不受本统计记录。

结果：一个长期忙碌的会话会让其定时任务的 `fireCount` 虚增、`lastFireTime` 失真，管理后台/用户看到的"执行次数/最后执行时间"与真实执行完全脱节，且与 `COMPLETED`/`FAILED` 分支"真实执行后才计数"的语义不一致。

**修复建议**：

QUEUED 分支不应计入 `fireCount` 与 `lastFireTime`，可在入队后直接 `return` 且保持 `countThisRun = false`，或调整 `finally` 逻辑：仅在 `lastExecutionStatus !== 'QUEUED'` 时累加 `fireCount`/刷新 `lastFireTime`：

```ts
} finally {
  if (!countThisRun) return;
  if (task.lastExecutionStatus !== 'QUEUED' && task.lastExecutionStatus != null) {
    task.lastFireTime = formatDateTime(new Date());
    task.fireCount = (task.fireCount ?? 0) + 1;
  }
  ...同原逻辑（finished 判定不变）
}
```

---

## BUG #6 — `markMessageComplete` 未重置流式状态，与 `finishInterruptedStreamingMessage` 不一致（前端状态残留）

**文件**：`desktop/src/stores/session.ts:1309-1312`
**严重程度**：🟡 中（流式状态未清理）

**问题代码**：

```ts
function markMessageComplete(sessionId: string, _data: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) {
    streamingAssistantMessageIds.delete(String(sessionId))
    // Message end — the full assistant message is now persisted server-side
    // Refresh will pick it up via fetchMessages
  }
```

**对比 `finishInterruptedStreamingMessage`**：

```ts
function finishInterruptedStreamingMessage(sessionId: string) {
    // ...
    streamingAssistantMessageIds.delete(sid)
    sessionStreaming.value.set(sid, false)  // ← 正确重置
    sessionThinking.value.set(sid, false)   // ← 正确重置
  }
```

**根因分析**：

`markMessageComplete` 仅清除了 `streamingAssistantMessageIds`，但**没有重置 `sessionStreaming` 和 `sessionThinking`** 这两个响应式状态。而 `finishInterruptedStreamingMessage` 在相同场景下会正确重置两者。`message_end` 事件（`useStreamWS.ts` `case 'message_end'` → `markMessageComplete`）在 AgentLoop 完成时发出，若 `session_status` 的 terminal phase 事件在客户端已被消费/延迟/因连接抖动丢失，则：

- `sessionStreaming` 仍为 `true`，前端流式进度条/旋转指示器持续显示
- `sessionThinking` 仍为 `true`，思考状态指示器持续显示
- 用户界面残留运行中状态，直到下次会话刷新或手动干预

两个处理同一语义（"一条助手消息结束"）的入口行为不一致，属于典型的"漏重置"缺陷。

**修复建议**：

```ts
function markMessageComplete(sessionId: string, _data: { ... }) {
    const sid = String(sessionId)
    streamingAssistantMessageIds.delete(sid)
    sessionStreaming.value.set(sid, false)
    sessionThinking.value.set(sid, false)
}
```

---

## 汇总

| # | 模块 | BUG 描述 | 严重程度 | 类型 |
|---|------|----------|----------|------|
| 1 | harness/tool | `WriteFileTool` `total_lines` 未处理尾部换行，行数统计多算 | 🟡 中 | 数据不一致 |
| 2 | harness/tool | `TaskUpdateTool` 传递 `NaN` id 给 `resetInProgress`，状态流转静默失败 | 🟡 中 | 静默失败 |
| 3 | harness/tool | `lineAt` 计算 `lineEnd` 但未使用，行预览文本截断不完整 | 🟡 中 | UI 展示错误 |
| 4 | harness/core | `executeToolCalls` 多工具并行路径缺执行前取消检查，取消失效且并发写存竞态 | 🟡 中 | 并发/取消不一致 |
| 5 | schedule | 定时任务 QUEUED（仅入队）仍累计 `fireCount` 并刷新 `lastFireTime`，执行统计失真 | 🟡 中 | 统计语义错误 |
| 6 | desktop/stores | `markMessageComplete` 未重置流式状态，前端残留运行中指示 | 🟡 中 | 状态残留 |

**建议优先修复**：BUG #2（待办状态静默失败）、BUG #4（取消失效与并发竞态）、BUG #6（流式状态残留）。