# 思考内容（Thinking Content）展示功能技术设计

## 1. 问题分析

### 1.1 现象

部分大模型（如 mimo-v2.5-pro、DeepSeek-R1 等）在流式输出时会先输出思考/推理过程（`reasoning_content`），再输出正式回答（`content`）。当前系统中，思考内容被完全丢弃，客户端无法展示模型的推理过程。

### 1.2 数据流追踪

LLM SSE 响应中，`reasoning_content` 和 `content` 的时序关系：

```
data: {"choices":[{"delta":{"reasoning_content":"让我分析..."}}]}
data: {"choices":[{"delta":{"reasoning_content":"这个问题需要"}}]}
data: {"choices":[{"delta":{"reasoning_content":"考虑三个方面"}}]}
data: {"choices":[{"delta":{"content":"根据分析..."}}]}
data: {"choices":[{"delta":{"content":"结果如下"}}]}
```

`reasoning_content` 块先于 `content` 块到达，两者不会同时出现在同一个 delta 中。

### 1.3 当前数据丢失点

数据流经以下层级，其中 **粗体** 标记了数据丢失位置：

| 层级 | 文件 | 状态 |
|------|------|------|
| SSE 解析 | `StreamChunk.java:38` | 已解析 `reasoningContent` 字段 |
| LLM 适配器 | `OpenAiLlmAdapter.java:102` | 完整传递 StreamChunk |
| **Agent 循环** | **`AgentLoop.java:118-145`** | **`delta.getReasoningContent()` 从未被读取** |
| **事件监听器** | **`AgentEventListener.java:45-49`** | **`onThinkingStart/End` 无参数，无内容传递通道** |
| **WS 事件发送** | **`WsStreamingEventListener.java:185-191`** | **`thinking_start/end` 发送空数据** |
| WS 路由 | `useStreamWS.ts:281-293` | 仅设置 boolean 标记 |
| 会话状态 | `session.ts:51` | `sessionThinking` 仅为 `Map<string, boolean>` |
| 消息类型 | `chat.ts:12-14` | `MessageSegment` 无 thinking 类型 |
| 消息渲染 | `MessageBubble.vue` | 无思考内容渲染逻辑 |

**根本原因**：`AgentLoop.onChunk` 中只处理了 `delta.getContent()` 和 `delta.getToolCalls()`，完全忽略了 `delta.getReasoningContent()`。从这一层开始，思考内容在后续所有层级中都不存在。

---

## 2. 解决方案

### 2.1 设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 存储方式 | 独立 `thinking_content` 列 | 天然隔离于 LLM 上下文构建，无需 JSON 解析，schema 自描述 |
| WS 事件 | 新增 `thinking_delta` 事件类型 | 与 `content_delta` 模式一致，支持真正流式展示 |
| 前端存储 | `ChatMessage.thinkingContent` 字段 + `thinking` segment 类型 | 与现有 segment 体系一致 |
| 上下文构建 | 不发送思考内容给 LLM | 思考内容是模型内部过程，不应参与对话历史 |
| UI 展示 | 可折叠区块，历史默认折叠，流式时默认展开 | 参考 ToolCallGroup 现有模式 |

### 2.2 整体架构

```
LLM SSE Stream
  │
  ▼
StreamChunk.Delta.reasoningContent  ← 已存在
  │
  ▼
AgentLoop.onChunk()                 ← 新增：读取 reasoningContent
  │  ├─ thinkingBuilder.append()
  │  └─ listener.onThinkingDelta()
  │
  ▼
AgentEventListener                  ← 新增：onThinkingDelta(String)
  │
  ▼
WsStreamingEventListener            ← 新增：send("thinking_delta", {delta})
  │
  ▼
WebSocket → 前端
  │
  ▼
useStreamWS routeEvent              ← 新增：case "thinking_delta"
  │
  ▼
sessionStore.appendThinkingDelta()  ← 新增
  │
  ▼
ChatMessage.thinkingContent + segments.push({type:'thinking'})
  │
  ▼
MessageBubble → ThinkingBlock.vue   ← 新增组件
```

---

## 3. 详细设计

### 3.1 数据库层

#### 新增迁移文件

**文件**：`backend/src/main/resources/db/migration/V031__add_message_thinking_content.sql`

```sql
ALTER TABLE `message` ADD COLUMN `thinking_content` MEDIUMTEXT NULL COMMENT '模型思考/推理内容' AFTER `content`;
```

- 添加在 `content` 列之后，保持逻辑关联
- `NULLABLE`：用户消息和不支持思考的模型消息不需要此字段
- `MEDIUMTEXT`：与 `content` 列类型一致，思考内容可能较长

#### Message 实体

**文件**：`backend/src/main/java/cn/etarch/mao/session/entity/Message.java`

在 `content` 字段之后新增：

```java
private String thinkingContent;
```

MyBatis-Plus 自动按驼峰转下划线映射到 `thinking_content` 列。

---

### 3.2 后端核心层

#### AgentEventListener 接口

**文件**：`backend/src/main/java/cn/etarch/mao/harness/core/AgentEventListener.java`

在 `onToolCallArgsDelta` 方法之后新增：

```java
/** 模型思考内容增量（在 content delta 之前到达） */
default void onThinkingDelta(String delta) {}
```

与现有的 `onThinkingStart()`（状态信号）不同，此方法携带实际的思考文本。

#### AgentLoop — 提取 reasoning_content

**文件**：`backend/src/main/java/cn/etarch/mao/harness/core/AgentLoop.java`

**改动 1**：在匿名 `StreamCallback` 中（约第 114 行），新增 `thinkingBuilder`：

```java
private final StringBuilder contentBuilder = new StringBuilder();
private final StringBuilder thinkingBuilder = new StringBuilder();  // 新增
```

**改动 2**：在 `onChunk` 方法中（第 124 行 `if (delta != null)` 块内），在 `delta.getContent()` 检查**之前**新增：

```java
if (delta.getReasoningContent() != null) {
    thinkingBuilder.append(delta.getReasoningContent());
    listener.onThinkingDelta(delta.getReasoningContent());
}
```

> 顺序很重要：`reasoning_content` 块先于 `content` 块到达。当第一个 `content` 块到来时，已有的 `thinkingEnded.compareAndSet` 逻辑会触发 `onThinkingEnd()`，正确结束思考阶段。

**改动 3**：在 `onComplete` 方法中（第 169 行 `String content = contentBuilder.toString()` 之后），新增：

```java
String thinkingContent = thinkingBuilder.length() > 0 ? thinkingBuilder.toString() : null;
```

**改动 4**：修改 `MessagePersistenceCallback` 接口签名（第 57 行）：

```java
void onSaveAssistantMessage(String content, String thinkingContent,
                            List<ChatRequest.ToolCall> toolCalls, ChatUsage usage);
```

**改动 5**：修改两处 `persistenceCallback.onSaveAssistantMessage(...)` 调用（第 173 行和第 200 行），传入 `thinkingContent`。

#### MessagePersistenceCallback 实现

**文件**：`backend/src/main/java/cn/etarch/mao/harness/core/HarnessService.java`

更新第 74 行的匿名实现：

```java
@Override
public void onSaveAssistantMessage(String content, String thinkingContent,
                                    List<ChatRequest.ToolCall> toolCalls, ChatUsage usage) {
    // ... 现有 toolCallsJson 序列化逻辑不变 ...
    sessionService.saveMessage(sessionId, "ASSISTANT", content, thinkingContent,
                                null, toolCallsJson, tokenCount, modelId);
}
```

#### SessionService — 保存思考内容

**文件**：`backend/src/main/java/cn/etarch/mao/session/service/SessionService.java`

**改动 1**：修改第一个 `saveMessage` 方法签名（第 139 行），新增 `thinkingContent` 参数：

```java
public Message saveMessage(Long sessionId, String role, String content, String thinkingContent,
                            String toolCallId, String toolCalls,
                            Integer tokenCount, Long modelId) {
```

在方法体内（第 145 行之后）新增：

```java
message.setThinkingContent(thinkingContent);
```

**改动 2**：同样修改第二个 `saveMessage` 重载（第 174 行）。

**改动 3**：更新 `StreamingWsHandler` 中的 `saveMessage` 调用（约第 256 行），用户消息传 `null`：

```java
sessionService.saveMessage(sessionId, "USER", messageContent, null, null, null, 0, null);
```

#### SessionController.MessageVO — API 返回

**文件**：`backend/src/main/java/cn/etarch/mao/session/controller/SessionController.java`

**改动 1**：在 `MessageVO` 内部类（约第 371 行）新增字段：

```java
private String thinkingContent;
```

**改动 2**：在 `toMessageVO()` 方法中（约第 289 行之后）新增映射：

```java
vo.setThinkingContent(message.getThinkingContent());
```

---

### 3.3 WebSocket 事件层

#### WsStreamingEventListener — 发送思考内容增量

**文件**：`backend/src/main/java/cn/etarch/mao/session/ws/WsStreamingEventListener.java`

在 `onThinkingEnd()` 方法之后（第 192 行之后）新增：

```java
@Override
public void onThinkingDelta(String delta) {
    send("thinking_delta", Map.of("delta", delta));
}
```

事件格式与 `content_delta` 一致：

```json
{
  "type": "thinking_delta",
  "sessionId": 123,
  "data": { "delta": "让我分析这个问题..." }
}
```

---

### 3.4 前端类型层

#### chat.ts — 新增类型定义

**文件**：`desktop/src/types/chat.ts`

**改动 1**：`MessageSegment` 联合类型新增 thinking 分支（第 12 行）：

```typescript
export type MessageSegment =
  | { type: 'text'; content: string }
  | { type: 'tool'; callId: string }
  | { type: 'thinking'; content: string }
```

**改动 2**：`ChatMessage` 接口新增字段（第 25 行之后）：

```typescript
thinkingContent?: string
```

---

### 3.5 前端状态管理层

#### chatMessage.ts — 新增累积函数

**文件**：`desktop/src/utils/chatMessage.ts`

在 `appendTextDelta` 函数之后新增：

```typescript
/** 流式思考内容增量：合并到尾部 thinking segment 或创建新 segment */
export function appendThinkingDelta(msg: ChatMessage, delta: string) {
  if (!delta) return
  if (!msg.segments) msg.segments = []
  msg.thinkingContent = (msg.thinkingContent || '') + delta

  const last = msg.segments[msg.segments.length - 1]
  if (last?.type === 'thinking') {
    last.content += delta
  } else {
    msg.segments.push({ type: 'thinking', content: delta })
  }
}
```

#### chatMessage.ts — 历史消息加载

在 `mapApiMessagesToChat` 函数中，处理从 API 加载的历史消息：

```typescript
// 在 buildSegmentsFromContentAndTools 调用之后
const thinkingContent = m.thinkingContent ? String(m.thinkingContent) : undefined
const segments = buildSegmentsFromContentAndTools(content, toolCalls)
if (thinkingContent) {
  segments.unshift({ type: 'thinking', content: thinkingContent })
}

// 在 result.push 中新增
thinkingContent: thinkingContent || undefined,
```

#### session.ts — 新增 store action

**文件**：`desktop/src/stores/session.ts`

在 `appendDelta` 函数之后新增：

```typescript
function appendThinkingDelta(sessionId: string, delta: string) {
  const sid = String(sessionId)
  const list = sessionMessages.value.get(sid)
  if (!list || list.length === 0) return
  const lastMsg = list[list.length - 1]
  if (lastMsg.role === 'assistant') {
    appendThinkingDeltaUtil(lastMsg, delta)
    sessionMessages.value.set(sid, [...list])
  }
}
```

在 return 块中导出此函数。

#### useStreamWS.ts — 路由 thinking_delta 事件

**文件**：`desktop/src/composables/useStreamWS.ts`

在 `thinking_end` case 之后新增：

```typescript
case 'thinking_delta':
  if (sessionId) sessionStore.appendThinkingDelta(sessionId, data.delta)
  break
```

---

### 3.6 前端渲染层

#### 新增 ThinkingBlock 组件

**文件**：`desktop/src/components/chat/ThinkingBlock.vue`（新建）

参考 `ToolCallGroup.vue` 的可折叠模式：

- **Props**：`thinking: string`（思考内容）、`streaming?: boolean`（是否正在流式输出）
- **状态**：`expanded` 响应式变量，`streaming` 时默认展开，历史消息默认折叠
- **头部**：显示"思考中..."或"Thinking"标签 + 展开/折叠箭头图标
- **内容**：`<pre>` 标签展示思考文本，支持自动滚动（流式时）
- **样式**：半透明背景、较小字体、左侧边框标识，与主内容区视觉区分

#### MessageBubble.vue — 集成 ThinkingBlock

**文件**：`desktop/src/components/chat/MessageBubble.vue`

**改动 1**：导入 `ThinkingBlock` 组件。

**改动 2**：在 `timelineSegments` 过滤逻辑中保留 thinking 类型 segment。

**改动 3**：在 `renderSegments` 计算属性的循环中，处理 thinking segment：

```typescript
if (seg.type === 'thinking') {
  flushToolBuffer()
  result.push({ type: 'thinking', content: seg.content || '' })
}
```

**改动 4**：在模板中新增渲染分支：

```html
<ThinkingBlock
  v-else-if="seg.type === 'thinking' && seg.content"
  :thinking="seg.content"
  :streaming="isAssistantRunning"
/>
```

---

### 3.7 上下文构建 — 无需改动

`HarnessService.buildContext()` 从数据库加载消息时只读取 `content`、`toolCallId`、`toolCalls` 字段，不会读取 `thinkingContent`。这是天然隔离的——思考内容不会被发送回 LLM，也不会消耗上下文 token。

`CompactionService` 同理，压缩时只处理 `content` 字段。

---

## 4. 实现顺序

为保持每步可编译，按以下顺序实施：

### 后端（需整体完成，否则编译失败）

| 步骤 | 文件 | 改动 |
|------|------|------|
| 1 | `V031__add_message_thinking_content.sql` | 新建迁移 |
| 2 | `Message.java` | 新增 `thinkingContent` 字段 |
| 3 | `AgentEventListener.java` | 新增 `onThinkingDelta` 默认方法 |
| 4 | `AgentLoop.java` | 新增 `thinkingBuilder`、修改 `onChunk`、修改 `MessagePersistenceCallback` 接口、更新 `onSaveAssistantMessage` 调用 |
| 5 | `HarnessService.java` | 更新 `onSaveAssistantMessage` 实现 |
| 6 | `SessionService.java` | 更新 `saveMessage` 签名 |
| 7 | `StreamingWsHandler.java` | 更新 `saveMessage` 调用（用户消息传 null） |
| 8 | `SessionController.java` | `MessageVO` 新增字段 + 映射 |
| 9 | `WsStreamingEventListener.java` | 新增 `onThinkingDelta` 实现 |

### 前端（需整体完成）

| 步骤 | 文件 | 改动 |
|------|------|------|
| 10 | `chat.ts` | 新增 `thinkingContent` 字段和 `thinking` segment 类型 |
| 11 | `chatMessage.ts` | 新增 `appendThinkingDelta` + 更新 `mapApiMessagesToChat` |
| 12 | `session.ts` | 新增 `appendThinkingDelta` action |
| 13 | `useStreamWS.ts` | 新增 `thinking_delta` 事件路由 |
| 14 | `ThinkingBlock.vue` | 新建组件 |
| 15 | `MessageBubble.vue` | 集成 ThinkingBlock |

---

## 5. 验证方案

### 5.1 编译验证

```bash
cd backend && mvn compile
cd desktop && npm run build
```

### 5.2 功能验证

1. **流式思考内容**：向支持 reasoning_content 的模型（如 mimo-v2.5-pro）发送消息，验证：
   - 思考内容实时流式展示在可折叠区块中
   - 区块在流式过程中自动展开
   - 思考结束后，正式回答正常展示在思考区块下方

2. **历史消息**：刷新页面重新加载会话，验证：
   - 思考内容从 API 正确加载
   - 历史消息的思考区块默认折叠
   - 点击可展开查看完整思考内容

3. **不支持思考的模型**：向不输出 reasoning_content 的模型发送消息，验证：
   - 不出现思考区块
   - 其他功能不受影响

4. **上下文隔离**：验证思考内容不会出现在发送给 LLM 的上下文中（通过日志检查 prompt 内容）

5. **工具调用场景**：模型先思考、再调用工具、再思考、再回答的多轮场景，验证：
   - 每轮的思考内容正确归属
   - 思考、工具调用、文本回答的 segment 顺序正确

---

## 6. 涉及文件清单

### 新建文件
- `backend/src/main/resources/db/migration/V031__add_message_thinking_content.sql`
- `desktop/src/components/chat/ThinkingBlock.vue`

### 修改文件
- `backend/src/main/java/cn/etarch/mao/session/entity/Message.java`
- `backend/src/main/java/cn/etarch/mao/harness/core/AgentEventListener.java`
- `backend/src/main/java/cn/etarch/mao/harness/core/AgentLoop.java`
- `backend/src/main/java/cn/etarch/mao/harness/core/HarnessService.java`
- `backend/src/main/java/cn/etarch/mao/session/service/SessionService.java`
- `backend/src/main/java/cn/etarch/mao/session/ws/StreamingWsHandler.java`
- `backend/src/main/java/cn/etarch/mao/session/controller/SessionController.java`
- `backend/src/main/java/cn/etarch/mao/session/ws/WsStreamingEventListener.java`
- `desktop/src/types/chat.ts`
- `desktop/src/utils/chatMessage.ts`
- `desktop/src/stores/session.ts`
- `desktop/src/composables/useStreamWS.ts`
- `desktop/src/components/chat/MessageBubble.vue`
