# 工具调用提前展示 & 参数流式推送 技术方案

> Note: The `bash` tool has been removed. `shell` is now the only command execution tool. See `shell-unification-design.md`.

## 问题

LLM 流式输出工具调用时，`tool_call_start` 事件仅在 `onComplete` 回调中触发（即 id、name、arguments 全部输出完毕后）。对于大文件写入等场景，arguments 可能需要数秒甚至更久才能输出完成，期间前端无任何反馈。

## 目标

1. LLM 输出 toolCallId + functionName 后立即推送 `tool_call_start`，前端立即渲染 ToolCallCard
2. arguments 的后续增量通过新事件 `tool_call_args_delta` 实时推送到前端，ToolCallCard 实时更新参数内容
3. ToolCallCard 在参数未完成时展示 loading 态，完成后切换为正常态

## 现状数据流

```
LLM StreamChunk.Delta.toolCalls[]
        ↓
AgentLoop.mergeToolCall()  ← 累积 id/name/arguments 碎片到 List<ChatRequest.ToolCall>
        ↓ (onComplete)
遍历 toolCalls → listener.onToolCallStart(tc)  ← 此时 arguments 已完整
        ↓
WsStreamingEventListener.onToolCallStart() → send("tool_call_start", {tool_call_id, tool_name, arguments})
        ↓
前端 sessionStore.appendToolCallStart() → 解析 arguments JSON → 创建 ToolCall 对象 → 渲染 ToolCallCard
```

## 改造方案

### 一、后端改动

#### 1. AgentLoop.java — mergeToolCall 中检测首次可识别

**文件**: `backend/src/main/java/cn/etarch/mao/harness/core/AgentLoop.java`

修改 `mergeToolCall` 方法，在 id + name 首次同时具备时回调通知：

```java
private final Set<String> emittedEarlyStarts = new HashSet<>();

private void mergeToolCall(List<ChatRequest.ToolCall> existing, ChatRequest.ToolCall delta,
                           AgentEventListener listener) {
    // ... 现有合并逻辑不变 ...

    // 检测：合并后 id + name 首次同时具备
    if (!delta.getId().isEmpty() && delta.getFunction() != null
            && delta.getFunction().getName() != null && !delta.getFunction().getName().isEmpty()
            && emittedEarlyStarts.add(delta.getId())) {
        // 首次可识别，立即推送（arguments 可能还是片段）
        listener.onToolCallStart(delta);
    }
}
```

修改 `onComplete` 回调，跳过已提前推送的 tool call：

```java
// onComplete 中
if (!toolCalls.isEmpty()) {
    for (ChatRequest.ToolCall tc : toolCalls) {
        if (!emittedEarlyStarts.contains(tc.getId())) {
            listener.onToolCallStart(tc);  // 仅推送未提前推送过的
        }
    }
    context.setPendingToolCalls(toolCalls);
}
```

方法签名变更：`mergeToolCall` 需要额外接收 `AgentEventListener listener` 参数（从 `onChunk` 闭包中传入）。`emittedEarlyStarts` 在每轮循环开始时清空。

#### 2. AgentEventListener.java — 新增 onToolCallArgsDelta

**文件**: `backend/src/main/java/cn/etarch/mao/harness/core/AgentEventListener.java`

```java
/** 工具调用参数增量更新（LLM 流式输出 arguments 碎片时） */
default void onToolCallArgsDelta(String toolCallId, String argsDelta) {}
```

#### 3. AgentLoop.java — onChunk 中触发参数增量事件

在 `onChunk` 回调中，每次 mergeToolCall 后，对该 tool call 已知的 arguments 增量触发事件：

```java
if (delta.getToolCalls() != null) {
    for (ChatRequest.ToolCall tc : delta.getToolCalls()) {
        String argsBefore = findArguments(toolCalls, tc);  // 合并前的 arguments
        mergeToolCall(toolCalls, tc, listener);
        String argsAfter = findArguments(toolCalls, tc);   // 合并后的 arguments
        if (argsAfter != null && argsAfter.length() > (argsBefore != null ? argsBefore.length() : 0)) {
            String delta_args = argsAfter.substring(argsBefore != null ? argsBefore.length() : 0);
            listener.onToolCallArgsDelta(findId(toolCalls, tc), delta_args);
        }
    }
}
```

这里需要两个辅助方法从 `toolCalls` 列表中定位到已合并的 tool call 对象的 id 和当前 arguments 值。由于 `mergeToolCall` 是按 id 匹配追加的，可以根据 delta 的 index 定位。

**简化方案**：不比较前后差异，直接在每次 mergeToolCall 后推送完整的当前 arguments 值。前端用全量覆盖而非增量拼接，逻辑更简单：

```java
if (delta.getToolCalls() != null) {
    for (ChatRequest.ToolCall tc : delta.getToolCalls()) {
        mergeToolCall(toolCalls, tc, listener);
        // 推送当前已累积的完整 arguments
        ChatRequest.ToolCall merged = toolCalls.get(toolCalls.size() - 1);
        if (merged.getId() != null && merged.getFunction() != null) {
            String currentArgs = merged.getFunction().getArguments() != null
                ? merged.getFunction().getArguments() : "";
            listener.onToolCallArgsDelta(merged.getId(), currentArgs);
        }
    }
}
```

> **选择全量覆盖**：每次推送当前完整的 arguments 字符串，前端直接赋值而非拼接。好处是避免增量计算的复杂性，坏处是 WS 消息体略大。但 arguments 本身是字符串（如 JSON），且只在 LLM 流式输出期间发送，频率可控。

#### 4. WsStreamingEventListener.java — 实现新事件

**文件**: `backend/src/main/java/cn/etarch/mao/session/ws/WsStreamingEventListener.java`

```java
@Override
public void onToolCallArgsDelta(String toolCallId, String argsDelta) {
    send("tool_call_args_delta", Map.of(
            "tool_call_id", toolCallId,
            "arguments", argsDelta
    ));
}
```

#### 5. WS 事件契约变更

| 事件 | 时机 | 数据 |
|------|------|------|
| `tool_call_start` | id + name 首次可识别时（arguments 可能不完整） | `{tool_call_id, tool_name, arguments}` |
| `tool_call_args_delta` | **新增**，每次 arguments 累积更新时 | `{tool_call_id, arguments}`（全量） |
| `tool_call_result` | 工具执行完毕（不变） | `{tool_call_id, result, status, summary}` |

---

### 二、前端改动

#### 1. types/chat.ts — ToolCall 类型增加 argsStreaming

**文件**: `desktop/src/types/chat.ts`

```typescript
export interface ToolCall {
  id: string
  name: string
  input?: Record<string, unknown>
  result?: string
  summary?: string
  status: 'pending' | 'running' | 'success' | 'error'
  isExpanded: boolean
  argsStreaming: boolean  // 新增：arguments 是否仍在流式传输中
}
```

#### 2. chatMessage.ts — appendToolCallStart 标记 argsStreaming

**文件**: `desktop/src/utils/chatMessage.ts`

`appendToolCallStart` 创建 ToolCall 时设置 `argsStreaming: true`。

#### 3. sessionStore — 新增 updateToolCallArgs 方法

**文件**: `desktop/src/stores/session.ts`

```typescript
function updateToolCallArgs(sessionId: string, data: { tool_call_id: string; arguments: string }) {
  const sid = String(sessionId)
  const list = sessionMessages.value.get(sid)
  if (!list || list.length === 0) return
  const lastMsg = list[list.length - 1]
  if (lastMsg.toolCalls) {
    const call = lastMsg.toolCalls.find(c => c.id === data.tool_call_id)
    if (call) {
      try { call.input = JSON.parse(data.arguments) } catch { call.input = {} }
      sessionMessages.value.set(sid, [...list])
    }
  }
}
```

#### 4. sessionStore — updateToolCallResult 中关闭 argsStreaming

在 `updateToolCallResult` 中增加 `call.argsStreaming = false`。

#### 5. useStreamWS.ts — 路由新事件

**文件**: `desktop/src/composables/useStreamWS.ts`

```typescript
case 'tool_call_args_delta':
  if (sessionId) sessionStore.updateToolCallArgs(sessionId, data)
  break
```

#### 6. ToolCallCard.vue — 适配渐进式参数

**文件**: `desktop/src/components/chat/ToolCallCard.vue`

- `displaySummary`：当 `argsStreaming` 为 true 且尚无 preview 时，显示 `"工具名 · 参数加载中..."`
- `commandText`：直接从 `toolCall.input.command` 取值，由于 input 会随 args delta 实时更新，command 会自然渐进填充。无需特殊处理
- `hasExpandableBody`：增加对 `argsStreaming` 的判断，streaming 时也算有可展开内容
- 新增：在 `tool-command` 区域，当 `argsStreaming` 为 true 且 `commandText` 为空时，显示一个 mini loading 动画

---

### 三、时序图

```
LLM 流式输出
  │
  ├─ Delta(tool_calls=[{id:"call_1", function:{name:"write_file", arguments:""}}])
  │    → mergeToolCall: id+name 首次可识别
  │    → emit onToolCallStart("call_1", "write_file", "")     ← tool_call_start
  │    → emit onToolCallArgsDelta("call_1", "")               ← tool_call_args_delta
  │
  ├─ Delta(tool_calls=[{function:{arguments:'{"path":"game.ht"}}])
  │    → mergeToolCall: arguments 累积
  │    → emit onToolCallArgsDelta("call_1", '{"path":"game.ht"')
  │
  ├─ Delta(tool_calls=[{function:{arguments:'ml","content":"<!Do'}}])
  │    → mergeToolCall: arguments 累积
  │    → emit onToolCallArgsDelta("call_1", '{"path":"game.html","content":"<!Do')
  │
  │   ... (更多 delta) ...
  │
  ├─ Delta(tool_calls=[{function:{arguments:'...完整 JSON...'}}])
  │    → emit onToolCallArgsDelta("call_1", '{"path":"game.html","content":"<!DOCTYPE>...完整内容..."}')
  │
  └─ onComplete
       → emittedEarlyStarts 已包含 "call_1"，跳过重复推送
       → setPendingToolCalls → 执行工具

前端时序：
  tool_call_start    → 创建 ToolCallCard (argsStreaming=true, input 为空/不完整)
  tool_call_args_delta × N → 实时更新 ToolCallCard 的 input (命令渐进显示)
  tool_call_result   → 更新状态为 success/error, argsStreaming=false
```

---

### 四、改动文件清单

| 文件 | 改动 |
|------|------|
| `AgentEventListener.java` | 新增 `onToolCallArgsDelta` 默认方法 |
| `AgentLoop.java` | `mergeToolCall` 检测首次可识别并回调；`onChunk` 中推送 args delta；`onComplete` 跳过已推送的；新增 `emittedEarlyStarts` 集合 |
| `WsStreamingEventListener.java` | 实现 `onToolCallArgsDelta`，发送 `tool_call_args_delta` 事件 |
| `types/chat.ts` | ToolCall 增加 `argsStreaming` 字段 |
| `chatMessage.ts` | `appendToolCallStart` 设置 `argsStreaming: true` |
| `session.ts` | 新增 `updateToolCallArgs` 方法；`updateToolCallResult` 中关闭 `argsStreaming` |
| `useStreamWS.ts` | 路由 `tool_call_args_delta` 事件 |
| `ToolCallCard.vue` | 适配渐进式参数展示，streaming 时显示 loading |

---

### 五、注意事项

1. **arguments 全量推送 vs 增量拼接**：方案选择全量推送（每次发完整的 arguments 字符串），前端直接 `JSON.parse` 赋值。相比增量拼接更简单可靠，避免了前端拼接字符串再解析的开销。arguments 通常在 10KB 以内（大文件写入的 content 除外），WS 传输开销可接受。

2. **大文件 write_file 的 arguments**：LLM 输出大文件内容时，arguments 可能非常大（数十 KB）。全量推送意味着每个 delta 都发送当前累积的完整字符串。如果性能成为瓶颈，可后续优化为仅推送新增部分（前端拼接后再 parse）。当前方案优先保证正确性和简单性。

3. **与 thinking 事件的关系**：`onThinkingEnd` 在首次收到 content delta 或 onComplete 时触发。tool call 的 delta 不触发 `onThinkingEnd`（因为 `delta.getContent()` 为 null），所以 thinking 状态和工具参数流式传输是互斥的，不会冲突。

4. **与 approval 流程的关系**：审批发生在执行阶段（`LocalToolExecutor.sendToolRequest` → Electron `handleBashFromWebSocket` → `requestToolApproval`），使用的是最终完整的 arguments。`tool_call_start` 提前推送不影响审批时机和审批内容。

5. **emittedEarlyStarts 清理时机**：在 `AgentLoop.execute()` 的每轮 while 循环开头清空，避免跨轮次污染。
