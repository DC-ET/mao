# 编辑用户消息并重新发送 — 技术方案

## 1. 需求概述

### 1.1 功能定义

支持用户编辑已发送的最后一条用户消息内容，并重新触发 Agent 执行。

### 1.2 约束条件

- **仅允许编辑最后一条用户消息**：不允许编辑中间的历史消息
- **截断策略**：编辑后删除该消息之后的所有消息（assistant、tool 等），重新生成回复
- **状态要求**：Session 处于非运行状态（IDLE、COMPLETED、FAILED、CANCELLED）时可编辑；RUNNING/RESUMING 状态下禁止编辑

### 1.3 用户体验

- 交互方式：hover 消息气泡 → 点击编辑按钮 → 进入编辑态 → 修改内容 → 确认发送/取消
- 乐观更新：前端立即截断消息列表，无需等待服务端响应

---

## 2. 数据库变更

### 2.1 Message 表新增字段

```sql
-- Flyway 迁移脚本：V25__add_message_updated_at.sql
ALTER TABLE message ADD COLUMN updated_at DATETIME NULL COMMENT '消息更新时间，仅用户消息编辑时填充';
```

### 2.2 Message 实体类更新

**文件**：`backend/src/main/java/com/agentworkbench/session/entity/Message.java`

新增字段：

```java
@TableField(fill = FieldFill.INSERT_UPDATE)
private LocalDateTime updatedAt;
```

---

## 3. 后端改动

### 3.1 接口设计

#### 3.1.1 WebSocket 消息类型（主流程）

**客户端 → 服务端**

```json
{
  "type": "edit_and_resend",
  "sessionId": "123",
  "messageId": "456",
  "content": "编辑后的新内容",
  "images": []
}
```

**服务端 → 客户端**

复用现有事件类型：
- `content_delta` — 流式文本
- `tool_call_start` / `tool_call_result` — 工具调用
- `session_status` — 会话状态变更

#### 3.1.2 HTTP 接口（备用/调试用）

```
PATCH /api/v1/sessions/{sessionId}/messages/{messageId}
Content-Type: application/json

Request:
{
  "content": "编辑后的新内容",
  "images": ["https://oss.example.com/image1.jpg"]
}

Response:
{
  "code": 0,
  "data": {
    "id": 456,
    "sessionId": 123,
    "role": "USER",
    "content": "编辑后的新内容",
    "createdAt": "2026-06-04T18:20:47",
    "updatedAt": "2026-06-05T10:30:00"
  }
}
```

### 3.2 SessionService 新增方法

**文件**：`backend/src/main/java/com/agentworkbench/session/service/SessionService.java`

```java
/**
 * 编辑用户消息并截断后续消息
 *
 * @param messageId  待编辑的消息ID
 * @param newContent 新的消息内容
 * @param images     新的图片列表（可为空）
 * @return 更新后的消息对象
 * @throws IllegalArgumentException 如果消息不存在或非用户消息
 */
public Message editMessageAndTruncate(Long messageId, String newContent, List<String> images) {
    // 1. 查询目标消息，校验 role=USER
    Message message = messageMapper.selectById(messageId);
    if (message == null || !"USER".equals(message.getRole())) {
        throw new IllegalArgumentException("只能编辑用户消息");
    }

    // 2. 更新消息内容
    message.setContent(buildContent(newContent, images));
    message.setUpdatedAt(LocalDateTime.now());
    messageMapper.updateById(message);

    // 3. 删除该消息之后的所有消息（按 created_at 降序删除）
    LambdaQueryWrapper<Message> deleteWrapper = new LambdaQueryWrapper<Message>()
            .eq(Message::getSessionId, message.getSessionId())
            .gt(Message::getCreatedAt, message.getCreatedAt());
    messageMapper.delete(deleteWrapper);

    return message;
}

/**
 * 构建消息内容（支持纯文本和多模态）
 */
private String buildContent(String text, List<String> images) {
    if (images == null || images.isEmpty()) {
        return text;
    }
    // 多模态内容使用 JSON 数组格式
    List<Map<String, String>> parts = new ArrayList<>();
    parts.add(Map.of("type", "text", "text", text));
    for (String imageUrl : images) {
        parts.add(Map.of("type", "image_url", "image_url", imageUrl));
    }
    return JsonUtils.toJsonString(parts);
}
```

### 3.3 StreamingWsHandler 新增处理

**文件**：`backend/src/main/java/com/agentworkbench/session/ws/StreamingWsHandler.java`

在 `handleTextMessage` 方法中新增 `edit_and_resend` 类型处理：

```java
case "edit_and_resend":
    handleEditAndResend(session, user, messageNode);
    break;
```

核心逻辑：

```java
private void handleEditAndResend(WebSocketSession session, User user, JsonNode messageNode) {
    Long sessionId = messageNode.get("sessionId").asLong();
    Long messageId = messageNode.get("messageId").asLong();
    String content = messageNode.get("content").asText();
    List<String> images = parseImages(messageNode);

    // 1. 校验 session 状态（必须是非运行状态）
    Session sessionEntity = sessionService.getSession(sessionId);
    if (sessionEntity == null) {
        sendError(session, "会话不存在");
        return;
    }
    TaskPhase phase = TaskPhase.valueOf(sessionEntity.getPhase());
    if (phase == TaskPhase.RUNNING || phase == TaskPhase.RESUMING) {
        sendError(session, "会话正在执行中，无法编辑");
        return;
    }

    // 2. 校验是否是最后一条用户消息
    List<Message> messages = sessionService.getMessages(sessionId);
    Message lastUserMsg = messages.stream()
            .filter(m -> "USER".equals(m.getRole()))
            .reduce((a, b) -> b)
            .orElse(null);
    if (lastUserMsg == null || !lastUserMsg.getId().equals(messageId)) {
        sendError(session, "只能编辑最后一条用户消息");
        return;
    }

    // 3. 编辑消息并截断后续消息
    Message editedMessage = sessionService.editMessageAndTruncate(messageId, content, images);

    // 4. 订阅会话事件
    wsRegistry.subscribe(user.getId(), sessionId, session);

    // 5. 构建多模态内容并提交执行
    Object multimodalContent = buildMultimodalContent(content, images, sessionEntity);
    agentExecutor.submit(() -> executeAgent(sessionId, multimodalContent, sessionEntity.getAgentId(),
            sessionEntity.getExecutionMode(), user.getId()));
}
```

### 3.4 校验逻辑总结

| 校验项 | 条件 | 错误提示 |
|--------|------|----------|
| Session 存在 | sessionId 有效 | "会话不存在" |
| Session 状态 | phase ∉ {RUNNING, RESUMING} | "会话正在执行中，无法编辑" |
| 消息存在 | messageId 有效 | "消息不存在" |
| 消息类型 | role = USER | "只能编辑用户消息" |
| 最后一条 | 是 session 中最后一条 USER 消息 | "只能编辑最后一条用户消息" |

---

## 4. 前端改动

### 4.1 类型定义

**文件**：`desktop/src/types/chat.ts`

```typescript
// ChatMessage 新增字段
interface ChatMessage {
  // ... 现有字段
  updatedAt?: string  // 编辑时间，未编辑则为空
}
```

### 4.2 MessageBubble 组件

**文件**：`desktop/src/components/chat/MessageBubble.vue`

#### 4.2.1 新增 Props

```typescript
interface Props {
  // ... 现有 props
  isEditing?: boolean
  canEdit?: boolean
  onEdit?: () => void
  onCancelEdit?: () => void
  onConfirmEdit?: (newContent: string) => void
}
```

#### 4.2.2 UI 变更

1. **编辑按钮**：user 消息 hover 时显示铅笔图标按钮
2. **编辑态**：message content 区域切换为 textarea
3. **操作按钮**：编辑态显示确认（✓）和取消（✗）按钮

```
┌─────────────────────────────────────────────────────┐
│  正常态：                                            │
│  ┌─────────────────────────────────────────────┐   │
│  │ 用户消息内容                                  │   │
│  └─────────────────────────────────────────────┘   │
│                                        [编辑] [复制] │
├─────────────────────────────────────────────────────┤
│  编辑态：                                            │
│  ┌─────────────────────────────────────────────┐   │
│  │ ┌─────────────────────────────────────────┐ │   │
│  │ │ 编辑后的消息内容                          │ │   │
│  │ │                                         │ │   │
│  │ └─────────────────────────────────────────┘ │   │
│  └─────────────────────────────────────────────┘   │
│                              [确认] [取消]           │
└─────────────────────────────────────────────────────┘
```

#### 4.2.3 关键代码结构

```vue
<template>
  <div class="message-bubble" @mouseenter="showActions = true" @mouseleave="showActions = false">
    <!-- 正常态 -->
    <div v-if="!isEditing" class="message-content">
      <slot />
    </div>

    <!-- 编辑态 -->
    <div v-else class="message-edit">
      <textarea
        ref="editInput"
        v-model="editContent"
        @keydown.escape="onCancelEdit"
        @keydown.enter.ctrl="handleConfirm"
        rows="3"
      />
      <div class="edit-actions">
        <button @click="handleConfirm" :disabled="!editContent.trim()">
          <CheckIcon /> 确认
        </button>
        <button @click="onCancelEdit">
          <XIcon /> 取消
        </button>
      </div>
    </div>

    <!-- 操作按钮（仅正常态显示） -->
    <div v-if="showActions && !isEditing && canEdit" class="message-actions">
      <button @click="onEdit" title="编辑消息">
        <PencilIcon />
      </button>
      <button @click="handleCopy" title="复制">
        <CopyIcon />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'

const props = defineProps<{
  isEditing?: boolean
  canEdit?: boolean
  content?: string
  onEdit?: () => void
  onCancelEdit?: () => void
  onConfirmEdit?: (newContent: string) => void
}>()

const editContent = ref(props.content || '')
const editInput = ref<HTMLTextAreaElement>()

watch(() => props.isEditing, async (editing) => {
  if (editing) {
    editContent.value = props.content || ''
    await nextTick()
    editInput.value?.focus()
  }
})

const handleConfirm = () => {
  if (editContent.value.trim()) {
    props.onConfirmEdit?.(editContent.value)
  }
}
</script>
```

### 4.3 useChat composable

**文件**：`desktop/src/composables/useChat.ts`

#### 4.3.1 新增方法

```typescript
/**
 * 编辑最后一条用户消息并重新发送
 */
async function editAndResend(messageId: number, newContent: string, images: string[] = []) {
  if (!sessionId.value) return

  // 1. 校验状态
  if (sending.value) {
    console.warn('会话正在执行中，无法编辑')
    return
  }

  // 2. 校验是否是最后一条用户消息
  const messages = sessionStore.getSessionMessages(sessionId.value)
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
  if (!lastUserMsg || lastUserMsg.id !== messageId) {
    console.warn('只能编辑最后一条用户消息')
    return
  }

  // 3. 乐观更新：截断后续消息，更新编辑内容
  sessionStore.truncateMessagesAfter(sessionId.value, messageId)
  sessionStore.updateMessageContent(sessionId.value, messageId, newContent, images)

  // 4. 添加空 assistant 占位消息
  const placeholderMsg: ChatMessage = {
    id: Date.now(), // 临时 ID
    role: 'assistant',
    content: '',
    segments: [],
    toolCalls: []
  }
  sessionStore.appendMessage(sessionId.value, placeholderMsg)

  // 5. 通过 WS 发送编辑请求
  const pendingCallback = createPendingCallback()
  ws.send(JSON.stringify({
    type: 'edit_and_resend',
    sessionId: sessionId.value,
    messageId,
    content: newContent,
    images
  }))

  // 6. 等待执行完成
  sending.value = true
  try {
    await pendingCallback.promise
  } finally {
    sending.value = false
  }
}
```

#### 4.3.2 返回值更新

```typescript
return {
  // ... 现有返回值
  editAndResend
}
```

### 4.4 Session Store

**文件**：`desktop/src/stores/session.ts`

#### 4.4.1 新增方法

```typescript
/**
 * 截断指定消息之后的所有消息
 */
function truncateMessagesAfter(sessionId: string, messageId: number) {
  const messages = sessionMessages.get(sessionId)
  if (!messages) return

  const targetIndex = messages.findIndex(m => m.id === messageId)
  if (targetIndex === -1) return

  // 保留目标消息及其之前的消息
  sessionMessages.set(sessionId, messages.slice(0, targetIndex + 1))
}

/**
 * 更新指定消息的内容
 */
function updateMessageContent(
  sessionId: string,
  messageId: number,
  newContent: string,
  images?: string[]
) {
  const messages = sessionMessages.get(sessionId)
  if (!messages) return

  const message = messages.find(m => m.id === messageId)
  if (message) {
    message.content = newContent
    message.images = images
    message.updatedAt = new Date().toISOString()
    // 触发响应式更新
    sessionMessages.set(sessionId, [...messages])
  }
}

/**
 * 追加消息到会话
 */
function appendMessage(sessionId: string, message: ChatMessage) {
  const messages = sessionMessages.get(sessionId) || []
  messages.push(message)
  sessionMessages.set(sessionId, messages)
}
```

#### 4.4.2 mapApiMessagesToChat 适配

**文件**：`desktop/src/utils/chatMessage.ts`

在 `mapApiMessagesToChat` 函数中处理 `updatedAt` 字段：

```typescript
export function mapApiMessagesToChat(apiMessages: ApiMessage[]): ChatMessage[] {
  // ... 现有逻辑

  return chatMessages.map(msg => ({
    // ... 现有映射
    updatedAt: msg.updatedAt || undefined
  }))
}
```

### 4.5 TaskView 适配

**文件**：`desktop/src/views/task/TaskView.vue`

#### 4.5.1 新增状态

```typescript
const editingMessageId = ref<number | null>(null)
```

#### 4.5.2 模板变更

```vue
<template>
  <!-- 用户消息渲染 -->
  <MessageBubble
    v-if="msg.role === 'user'"
    :message="msg"
    :show-time="true"
    :can-edit="canEditMessage(msg)"
    :is-editing="editingMessageId === msg.id"
    :content="msg.content"
    @edit="startEdit(msg)"
    @cancel-edit="cancelEdit"
    @confirm-edit="confirmEdit(msg.id, $event)"
  >
    <!-- 消息内容 -->
  </MessageBubble>
</template>
```

#### 4.5.3 方法定义

```typescript
const canEditMessage = (msg: ChatMessage) => {
  // 只允许编辑最后一条用户消息，且 session 未在运行中
  const messages = sessionStore.getSessionMessages(sessionId.value!)
  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user')
  return lastUserMsg?.id === msg.id && !useChatInstance.sending.value
}

const startEdit = (msg: ChatMessage) => {
  editingMessageId.value = msg.id
}

const cancelEdit = () => {
  editingMessageId.value = null
}

const confirmEdit = async (messageId: number, newContent: string) => {
  editingMessageId.value = null
  await useChatInstance.editAndResend(messageId, newContent)
}
```

---

## 5. 交互流程

### 5.1 正常流程

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│   前端       │     │   后端       │     │   Agent     │
└──────┬──────┘     └──────┬──────┘     └──────┬──────┘
       │                   │                   │
       │  1. 用户点击编辑    │                   │
       │  进入编辑态        │                   │
       │                   │                   │
       │  2. 乐观更新UI    │                   │
       │  截断消息列表      │                   │
       │                   │                   │
       │  3. WS: edit_and_resend              │
       │  ───────────────> │                   │
       │                   │                   │
       │                   │  4. 校验session状态 │
       │                   │  校验是否最后一条   │
       │                   │                   │
       │                   │  5. 编辑消息       │
       │                   │  截断后续消息       │
       │                   │                   │
       │                   │  6. 提交Agent执行   │
       │                   │  ───────────────> │
       │                   │                   │
       │  7. 流式返回       │  8. Agent执行     │
       │  content_delta    │  ───────────────> │
       │  <─────────────── │                   │
       │                   │                   │
       │  9. session_status │ 10. 执行完成      │
       │  (COMPLETED)      │ <─────────────── │
       │  <─────────────── │                   │
       │                   │                   │
       │  11. 更新UI       │                   │
       │  显示完整回复       │                   │
       │                   │                   │
```

### 5.2 异常流程

#### 5.2.1 Session 正在执行中

```
前端: 发送 edit_and_resend
后端: 检测到 phase = RUNNING
后端 → 前端: error "会话正在执行中，无法编辑"
前端: 恢复消息列表（取消乐观更新）
```

#### 5.2.2 非最后一条用户消息

```
前端: 发送 edit_and_resend
后端: 校验发现不是最后一条 USER 消息
后端 → 前端: error "只能编辑最后一条用户消息"
前端: 恢复消息列表（取消乐观更新）
```

---

## 6. 边界情况处理

| 场景 | 处理方式 |
|------|----------|
| 编辑内容为空 | 禁用确认按钮，不允许发送 |
| 编辑后取消 | 恢复原始消息内容，不触发任何后端操作 |
| 网络断开 | 乐观更新后无法完成，需提示用户刷新 |
| 多设备同时操作 | 后端校验最后一条消息逻辑保证一致性 |
| 编辑态时收到新消息 | 自动退出编辑态，显示新消息 |
| 图片编辑 | 编辑态支持重新上传/删除图片 |

---

## 7. 测试要点

### 7.1 后端测试

- [ ] 编辑最后一条用户消息成功
- [ ] 编辑非最后一条用户消息被拒绝
- [ ] 编辑时 session 运行中被拒绝
- [ ] 编辑后截断逻辑正确
- [ ] 多模态内容编辑

### 7.2 前端测试

- [ ] hover 显示编辑按钮（仅最后一条 user 消息）
- [ ] 进入编辑态，textarea 预填原内容
- [ ] Esc 取消编辑
- [ ] Ctrl+Enter / 点击确认发送
- [ ] 乐观更新立即反映 UI 变化
- [ ] 流式回复正常渲染
- [ ] 编辑态时自动退出（收到新消息）

---

## 8. 实施顺序

1. **后端优先**
   - 数据库迁移（V25）
   - Message 实体更新
   - SessionService.editMessageAndTruncate 方法
   - StreamingWsHandler 处理 edit_and_resend

2. **前端跟进**
   - 类型定义更新
   - Session Store 新增方法
   - useChat.editAndResend 方法
   - MessageBubble 编辑态 UI
   - TaskView 集成

3. **联调测试**
   - 完整流程验证
   - 异常场景覆盖

---

## 9. 设计决策记录

| 决策项 | 选择 | 原因 |
|--------|------|------|
| 截断 vs 分支 | 截断 | 简单清晰，与当前线性消息模型契合 |
| 编辑范围 | 仅最后一条 | 降低复杂度，符合常见交互模式 |
| 主流程通道 | WebSocket | 复用现有流式架构，避免 HTTP+WS 两次调用 |
| 乐观更新 | 是 | 提升用户体验，减少等待感 |
| updatedAt 字段 | 新增 | 标记编辑历史，支持未来审计需求 |
