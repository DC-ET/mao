# 消息队列 & 消息插入 技术方案

## 1. 需求概述

### 1.1 消息队列

当 Agent 正在执行任务时，允许用户继续发送消息。新消息进入队列等待，Agent 完成当前任务后自动消费队列中的下一条消息。

**核心规则**：
- Agent 空闲时，消息直接发送，不进队列
- Agent 忙碌时，消息进入队列
- 队列消息需要持久化，刷新页面不丢失
- 发送即移除，不关心执行结果
- 自动消费由后端触发
- 超过 5 条消息时，UI 折叠展示

### 1.2 消息插入

在消息队列基础上，用户可以主动选择队列中某条消息立即发送，打断当前 Agent 任务。

**核心规则**：
- 先停止当前 Agent 任务，再发送新消息
- 被打断的任务上下文保留在会话中，显示在对话窗口
- 防并发处理：避免连续点击，但连续发送的消息不能丢弃

### 1.3 队列管理

- 支持删除队列中的消息
- 支持上下箭头调整顺序
- 不支持编辑

---

## 2. 现状分析

### 2.1 当前消息发送流程

```
前端 ChatInput.handleSend()
  → TaskView.handleSend()
    → useChat.sendMessage()
      → WS 发送 { type: 'send_message', sessionId, data: { content, eventId, images } }
        → 后端 StreamingWsHandler.handleSendMessage()
          → 校验 session 未在运行中（非 RUNNING/RESUMING）
          → 持久化 USER 消息
          → 提交到 agentExecutor 线程池异步执行
```

**关键约束**：后端 `handleSendMessage()` 第一步就校验 session 状态，若为 RUNNING/RESUMING 则拒绝。

### 2.2 当前 Agent 状态管理

| 状态 | 含义 |
|------|------|
| `IDLE` | 空闲 |
| `RUNNING` | 执行中 |
| `RESUMING` | 恢复中（崩溃恢复） |
| `WAITING_APPROVAL` | 等待工具审批 |
| `COMPLETED` | 完成 |
| `FAILED` | 失败 |
| `CANCELLED` | 已取消 |
| `CANCELLING` | 取消中（前端状态） |

判断 Agent 是否忙碌：`phase === 'RUNNING' || phase === 'WAITING_APPROVAL'`

### 2.3 当前停止执行流程

```
前端 useChat.stopExecution()
  → 设 cancelling = true
  → WS 发送 { type: 'cancel', sessionId }
    → 后端设置 cancelFlag = true
    → AgentLoop 检测到 cancelFlag，退出循环
    → 后端更新 phase = CANCELLED，通知前端
    → 前端收到 session_status(CANCELLED)，resolve pendingCallback
```

---

## 3. 整体设计

### 3.1 架构概览

```
┌─────────────────────────────────────────────────────────┐
│  Frontend (Vue 3 + Pinia)                                │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ ChatInput    │  │ QueuePanel   │  │ MessageBubble  │  │
│  │ (输入框)     │  │ (队列面板)   │  │ (消息气泡)     │  │
│  └──────┬──────┘  └──────┬───────┘  └────────────────┘  │
│         │                │                                │
│  ┌──────┴────────────────┴───────────────────────────┐   │
│  │              useChat + sessionStore                │   │
│  └──────────────────────┬────────────────────────────┘   │
│                         │ WebSocket                        │
└─────────────────────────┼─────────────────────────────────┘
                          │
┌─────────────────────────┼─────────────────────────────────┐
│  Backend (Spring Boot)   │                                  │
│  ┌──────────────────────┴────────────────────────────┐    │
│  │            StreamingWsHandler                      │    │
│  │  ┌──────────────┐  ┌────────────────────────────┐ │    │
│  │  │ handleSend   │  │ handleInsert (新增)         │ │    │
│  │  │ _Message     │  │ handleQueueOps (新增)       │ │    │
│  │  └──────────────┘  └────────────────────────────┘ │    │
│  └──────────────────────┬────────────────────────────┘    │
│  ┌──────────────────────┴────────────────────────────┐    │
│  │            MessageQueueService (新增)              │    │
│  │  - enqueue / dequeue / delete / reorder            │    │
│  │  - autoConsume (Agent 完成后自动消费)               │    │
│  └──────────────────────┬────────────────────────────┘    │
│  ┌──────────────────────┴────────────────────────────┐    │
│  │            SessionService (修改)                   │    │
│  │  - updatePhase 增加自动消费钩子                     │    │
│  └───────────────────────────────────────────────────┘    │
│  ┌───────────────────────────────────────────────────┐    │
│  │            AgentLoop (修改)                        │    │
│  │  - cancelFlag 检查增强，支持外部中断               │    │
│  └───────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────┘
```

### 3.2 核心流程

#### 消息队列流程（Agent 忙碌时）

```
用户输入消息 → 前端判断 Agent 忙碌
  → WS 发送 { type: 'enqueue_message', sessionId, data: { content, images, eventId } }
    → 后端持久化到 message_queue 表
    → 返回 { type: 'queue_updated', sessionId, data: { queue: [...] } }
    → 前端更新队列面板
```

#### 自动消费流程（Agent 完成后）

```
Agent 执行完成 → 后端 updatePhase(COMPLETED)
  → 检查 message_queue 是否有待消费消息
  → 若有：dequeue 头部消息 → 自动触发 handleSendMessage 逻辑
  → 若无：正常完成
```

#### 消息插入流程（打断当前任务）

```
用户点击"立即发送" → 前端判断 Agent 忙碌
  → WS 发送 { type: 'insert_message', sessionId, data: { queueId } }
    → 后端设置 cancelFlag = true，停止当前 Agent
    → 等待 Agent 停止（超时 10s）
    → 从 message_queue 中移除该消息
    → 触发 handleSendMessage 逻辑
```

---

## 4. 数据库设计

### 4.1 新增表：message_queue

```sql
CREATE TABLE message_queue (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    session_id  BIGINT NOT NULL COMMENT '关联会话',
    user_id     BIGINT NOT NULL COMMENT '关联用户',
    content     TEXT NOT NULL COMMENT '消息内容',
    images      TEXT COMMENT '图片 URL JSON 数组',
    sort_order  INT NOT NULL DEFAULT 0 COMMENT '排序序号（越小越靠前）',
    status      VARCHAR(20) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING / DELETED',
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted     TINYINT NOT NULL DEFAULT 0,
    INDEX idx_session_id (session_id),
    INDEX idx_session_status (session_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**字段说明**：
| 字段 | 说明 |
|------|------|
| `id` | 主键自增 |
| `session_id` | 关联会话 ID |
| `user_id` | 关联用户 ID（冗余，便于查询） |
| `content` | 消息文本内容 |
| `images` | 图片 URL 数组 JSON，可为空 |
| `sort_order` | 排序序号，新消息默认追加到末尾（取 max + 1） |
| `status` | 状态：PENDING（待发送）、DELETED（已删除） |
| `deleted` | 逻辑删除标志 |

### 4.2 迁移脚本

文件：`V032__add_message_queue.sql`

```sql
CREATE TABLE message_queue (
    id          BIGINT AUTO_INCREMENT PRIMARY KEY,
    session_id  BIGINT NOT NULL,
    user_id     BIGINT NOT NULL,
    content     TEXT NOT NULL,
    images      TEXT,
    sort_order  INT NOT NULL DEFAULT 0,
    status      VARCHAR(20) NOT NULL DEFAULT 'PENDING',
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted     TINYINT NOT NULL DEFAULT 0,
    INDEX idx_session_id (session_id),
    INDEX idx_session_status (session_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

---

## 5. 后端设计

### 5.1 新增实体类

**文件**：`backend/src/main/java/cn/etarch/mao/session/entity/MessageQueue.java`

```java
@Data
@TableName("message_queue")
public class MessageQueue {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long sessionId;
    private Long userId;
    private String content;
    private String images;  // JSON array
    private Integer sortOrder;
    private String status;  // PENDING / DELETED
    @TableLogic
    private Integer deleted;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
```

### 5.2 新增 Mapper

**文件**：`backend/src/main/java/cn/etarch/mao/session/mapper/MessageQueueMapper.java`

```java
@Mapper
public interface MessageQueueMapper extends BaseMapper<MessageQueue> {
}
```

### 5.3 新增 MessageQueueService

**文件**：`backend/src/main/java/cn/etarch/mao/session/service/MessageQueueService.java`

核心方法：

```java
@Service
@RequiredArgsConstructor
public class MessageQueueService {
    private final MessageQueueMapper messageQueueMapper;

    /**
     * 入队：将消息加入队列末尾
     */
    public MessageQueue enqueue(Long sessionId, Long userId, String content, String images) {
        // 1. 查询当前队列最大 sortOrder
        Integer maxOrder = messageQueueMapper.selectOne(
            new LambdaQueryWrapper<MessageQueue>()
                .eq(MessageQueue::getSessionId, sessionId)
                .eq(MessageQueue::getStatus, "PENDING")
                .orderByDesc(MessageQueue::getSortOrder)
                .last("LIMIT 1")
        ).map(MessageQueue::getSortOrder).orElse(0);

        // 2. 创建队列消息
        MessageQueue item = new MessageQueue();
        item.setSessionId(sessionId);
        item.setUserId(userId);
        item.setContent(content);
        item.setImages(images);
        item.setSortOrder(maxOrder + 1);
        item.setStatus("PENDING");
        messageQueueMapper.insert(item);
        return item;
    }

    /**
     * 出队：取出并删除队列头部消息
     */
    public MessageQueue dequeue(Long sessionId) {
        MessageQueue head = messageQueueMapper.selectOne(
            new LambdaQueryWrapper<MessageQueue>()
                .eq(MessageQueue::getSessionId, sessionId)
                .eq(MessageQueue::getStatus, "PENDING")
                .orderByAsc(MessageQueue::getSortOrder)
                .last("LIMIT 1")
        );
        if (head != null) {
            head.setStatus("DELETED");
            messageQueueMapper.updateById(head);
        }
        return head;
    }

    /**
     * 删除指定队列消息
     */
    public void delete(Long queueId) {
        MessageQueue item = messageQueueMapper.selectById(queueId);
        if (item != null) {
            item.setStatus("DELETED");
            messageQueueMapper.updateById(item);
        }
    }

    /**
     * 重新排序：将指定消息上移/下移
     */
    public void reorder(Long queueId, String direction) {
        // direction: "up" / "down"
        // 通过交换 sort_order 实现
    }

    /**
     * 查询队列列表
     */
    public List<MessageQueue> listPending(Long sessionId) {
        return messageQueueMapper.selectList(
            new LambdaQueryWrapper<MessageQueue>()
                .eq(MessageQueue::getSessionId, sessionId)
                .eq(MessageQueue::getStatus, "PENDING")
                .orderByAsc(MessageQueue::getSortOrder)
        );
    }

    /**
     * 清空队列
     */
    public void clear(Long sessionId) {
        // 批量更新 status = DELETED
    }
}
```

### 5.4 修改 StreamingWsHandler

**新增事件处理**：

#### 5.4.1 enqueue_message（消息入队）

```java
case "enqueue_message":
    handleEnqueueMessage(sessionId, userId, data);
    break;
```

```java
private void handleEnqueueMessage(Long sessionId, Long userId, Map<String, Object> data) {
    String content = (String) data.get("content");
    String images = data.get("images") != null ? JsonUtils.toJson(data.get("images")) : null;

    MessageQueue item = messageQueueService.enqueue(sessionId, userId, content, images);

    // 通知前端队列更新
    List<MessageQueue> queue = messageQueueService.listPending(sessionId);
    registry.send(userId, WsEvent.of("queue_updated", sessionId, Map.of("queue", queue)));
}
```

#### 5.4.2 insert_message（消息插入 - 打断当前任务）

```java
case "insert_message":
    handleInsertMessage(sessionId, userId, data);
    break;
```

```java
private void handleInsertMessage(Long sessionId, Long userId, Map<String, Object> data) {
    Long queueId = Long.valueOf(data.get("queueId").toString());

    // 1. 设置取消标志，停止当前 Agent
    AtomicBoolean cancelFlag = cancelFlags.get(sessionId);
    if (cancelFlag != null) {
        cancelFlag.set(true);
    }

    // 2. 等待 Agent 停止（最多 10 秒）
    long deadline = System.currentTimeMillis() + 10_000;
    Session session = sessionService.getById(sessionId);
    while (System.currentTimeMillis() < deadline) {
        if (!"RUNNING".equals(session.getPhase()) && !"RESUMING".equals(session.getPhase())) {
            break;
        }
        Thread.sleep(200);
        session = sessionService.getById(sessionId);
    }

    // 3. 从队列中移除该消息
    MessageQueue item = messageQueueService.getById(queueId);
    messageQueueService.delete(queueId);

    // 4. 通知前端队列更新
    List<MessageQueue> queue = messageQueueService.listPending(sessionId);
    registry.send(userId, WsEvent.of("queue_updated", sessionId, Map.of("queue", queue)));

    // 5. 触发消息发送（复用 handleSendMessage 逻辑）
    Map<String, Object> sendData = new HashMap<>();
    sendData.put("content", item.getContent());
    sendData.put("images", item.getImages() != null ? JsonUtils.fromJson(item.getImages(), List.class) : null);
    sendData.put("eventId", UUID.randomUUID().toString());
    handleSendMessage(sessionId, userId, sendData);
}
```

#### 5.4.3 delete_queue_message（删除队列消息）

```java
case "delete_queue_message":
    handleDeleteQueueMessage(sessionId, userId, data);
    break;
```

```java
private void handleDeleteQueueMessage(Long sessionId, Long userId, Map<String, Object> data) {
    Long queueId = Long.valueOf(data.get("queueId").toString());
    messageQueueService.delete(queueId);

    List<MessageQueue> queue = messageQueueService.listPending(sessionId);
    registry.send(userId, WsEvent.of("queue_updated", sessionId, Map.of("queue", queue)));
}
```

#### 5.4.4 reorder_queue_message（调整队列顺序）

```java
case "reorder_queue_message":
    handleReorderQueueMessage(sessionId, userId, data);
    break;
```

```java
private void handleReorderQueueMessage(Long sessionId, Long userId, Map<String, Object> data) {
    Long queueId = Long.valueOf(data.get("queueId").toString());
    String direction = (String) data.get("direction"); // "up" / "down"
    messageQueueService.reorder(queueId, direction);

    List<MessageQueue> queue = messageQueueService.listPending(sessionId);
    registry.send(userId, WsEvent.of("queue_updated", sessionId, Map.of("queue", queue)));
}
```

### 5.5 修改 SessionService - 自动消费钩子

**文件**：`backend/src/main/java/cn/etarch/mao/session/service/SessionService.java`

在 `updatePhase()` 方法中，当 phase 变为终态（IDLE/COMPLETED/FAILED/CANCELLED）时，检查队列并自动消费：

```java
public void updatePhase(Long sessionId, String phase) {
    Session session = getById(sessionId);
    // ... 原有逻辑 ...

    // 更新 phase
    session.setPhase(phase);
    updateById(session);

    // 新增：自动消费队列
    if (isTerminalPhase(phase)) {
        autoConsumeQueue(sessionId);
    }
}

private boolean isTerminalPhase(String phase) {
    return "IDLE".equals(phase) || "COMPLETED".equals(phase)
        || "FAILED".equals(phase) || "CANCELLED".equals(phase);
}

private void autoConsumeQueue(Long sessionId) {
    MessageQueue head = messageQueueService.dequeue(sessionId);
    if (head != null) {
        // 异步触发消息发送
        // 需要获取 userId 和 registry，通过事件总线或直接调用
        // 这里需要将自动消费逻辑集成到 StreamingWsHandler 中
    }
}
```

**更好的方案**：将自动消费逻辑放在 `StreamingWsHandler` 的 agentExecutor 完成回调中，因为该位置已有 userId 和 registry 的引用。

```java
// StreamingWsHandler 中，agentExecutor 完成后
finally {
    cancelFlags.remove(sessionId);

    // 新增：自动消费队列
    MessageQueue head = messageQueueService.dequeue(sessionId);
    if (head != null) {
        // 通知前端队列更新
        List<MessageQueue> queue = messageQueueService.listPending(sessionId);
        registry.send(userId, WsEvent.of("queue_updated", sessionId, Map.of("queue", queue)));

        // 延迟一小段时间后触发下一条消息
        agentExecutor.submit(() -> {
            try {
                Thread.sleep(500); // 短暂延迟，确保前端状态同步
            } catch (InterruptedException ignored) {}

            Map<String, Object> sendData = new HashMap<>();
            sendData.put("content", head.getContent());
            sendData.put("images", head.getImages() != null ? JsonUtils.fromJson(head.getImages(), List.class) : null);
            sendData.put("eventId", UUID.randomUUID().toString());
            handleSendMessage(sessionId, userId, sendData);
        });
    }
}
```

### 5.6 修改 handleSendMessage - 移除忙碌校验

当前 `handleSendMessage()` 开头有校验：

```java
if ("RUNNING".equals(session.getPhase()) || "RESUMING".equals(session.getPhase())) {
    registry.send(userId, WsEvent.of("error", sessionId, Map.of("message", "Agent is currently running")));
    return;
}
```

这个校验保留不变。消息队列的入队通过 `enqueue_message` 处理，不走 `handleSendMessage`。自动消费和消息插入时调用 `handleSendMessage`，此时 Agent 已经停止，校验会通过。

### 5.7 Phase 扩展

当前 phase 枚举已足够，无需新增状态。`CANCELLING` 状态在前端维护，后端使用 `cancelFlag` 机制。

---

## 6. 前端设计

### 6.1 类型定义

**文件**：`desktop/src/types/chat.ts`

新增类型：

```typescript
export interface QueueMessage {
  id: string
  sessionId: string
  content: string
  images?: string[]
  sortOrder: number
  status: 'PENDING' | 'DELETED'
  createdAt: string
}
```

### 6.2 Session Store 扩展

**文件**：`desktop/src/stores/session.ts`

新增状态和方法：

```typescript
// 新增状态
const sessionQueueMessages = ref<Map<string, QueueMessage[]>>(new Map())

// 新增 computed
const activeQueueMessages = computed(() => {
  const sid = activeSessionId.value
  return sid ? sessionQueueMessages.value.get(sid) || [] : []
})

// 新增方法
function setQueueMessages(sessionId: string, queue: QueueMessage[]) {
  sessionQueueMessages.value.set(sessionId, queue)
}

function addToQueue(sessionId: string, msg: QueueMessage) {
  const list = sessionQueueMessages.value.get(sessionId) || []
  sessionQueueMessages.value.set(sessionId, [...list, msg])
}

function removeFromQueue(sessionId: string, queueId: string) {
  const list = sessionQueueMessages.value.get(sessionId) || []
  sessionQueueMessages.value.set(sessionId, list.filter(m => m.id !== queueId))
}

function clearQueue(sessionId: string) {
  sessionQueueMessages.value.delete(sessionId)
}

// 判断 Agent 是否忙碌（已有，这里列出供参考）
const isActive = computed(() => {
  const phase = activeSession.value?.phase
  return phase === 'RUNNING' || phase === 'WAITING_APPROVAL'
})
```

### 6.3 useChat 扩展

**文件**：`desktop/src/composables/useChat.ts`

新增方法：

```typescript
/**
 * 发送消息（带队列判断）
 * 如果 Agent 空闲，直接发送
 * 如果 Agent 忙碌，加入队列
 */
async function sendMessageWithQueue(text: string, files: File[]) {
  if (sessionStore.isActive) {
    // Agent 忙碌，加入队列
    await enqueueMessage(text, files)
  } else {
    // Agent 空闲，直接发送
    await sendMessage(text, files)
  }
}

/**
 * 消息入队
 */
async function enqueueMessage(text: string, files: File[]) {
  // 1. 上传图片（如果有）
  const imageUrls = files.length > 0 ? await uploadImages(files) : []

  // 2. 通过 WS 发送入队请求
  const eventId = crypto.randomUUID()
  wsEnqueueMessage(sessionId.value, text, eventId, imageUrls)
}

/**
 * 立即发送队列消息（打断当前任务）
 */
async function insertQueueMessage(queueId: string) {
  wsInsertMessage(sessionId.value, queueId)
}

/**
 * 删除队列消息
 */
async function deleteQueueMessage(queueId: string) {
  wsDeleteQueueMessage(sessionId.value, queueId)
}

/**
 * 调整队列顺序
 */
async function reorderQueueMessage(queueId: string, direction: 'up' | 'down') {
  wsReorderQueueMessage(sessionId.value, queueId, direction)
}
```

### 6.4 useStreamWS 扩展

**文件**：`desktop/src/composables/useStreamWS.ts`

新增发送方法：

```typescript
function wsEnqueueMessage(sessionId: string, content: string, eventId: string, images: string[]) {
  send({ type: 'enqueue_message', sessionId: Number(sessionId), data: { content, eventId, images } })
}

function wsInsertMessage(sessionId: string, queueId: string) {
  send({ type: 'insert_message', sessionId: Number(sessionId), data: { queueId } })
}

function wsDeleteQueueMessage(sessionId: string, queueId: string) {
  send({ type: 'delete_queue_message', sessionId: Number(sessionId), data: { queueId } })
}

function wsReorderQueueMessage(sessionId: string, queueId: string, direction: string) {
  send({ type: 'reorder_queue_message', sessionId: Number(sessionId), data: { queueId, direction } })
}
```

新增事件处理（在 `routeEvent` 中）：

```typescript
case 'queue_updated':
  sessionStore.setQueueMessages(String(sessionId), data.queue)
  break
```

### 6.5 新增组件：QueuePanel

**文件**：`desktop/src/components/chat/QueuePanel.vue`

```vue
<template>
  <div v-if="queueMessages.length > 0" class="queue-panel">
    <div class="queue-header">
      <span class="queue-title">待发送消息 ({{ queueMessages.length }})</span>
      <el-button text size="small" @click="toggleExpand">
        {{ expanded ? '收起' : '展开' }}
      </el-button>
    </div>

    <Transition name="queue-expand">
      <div v-if="expanded || queueMessages.length <= 5" class="queue-list">
        <div
          v-for="(msg, index) in queueMessages"
          :key="msg.id"
          class="queue-item"
        >
          <div class="queue-item-content">
            <span class="queue-index">{{ index + 1 }}.</span>
            <span class="queue-text">{{ truncate(msg.content, 50) }}</span>
            <span v-if="msg.images?.length" class="queue-images">
              [{{ msg.images.length }}张图片]
            </span>
          </div>
          <div class="queue-item-actions">
            <el-button
              text size="small"
              :disabled="index === 0"
              @click="handleReorder(msg.id, 'up')"
            >
              <el-icon><Top /></el-icon>
            </el-button>
            <el-button
              text size="small"
              :disabled="index === queueMessages.length - 1"
              @click="handleReorder(msg.id, 'down')"
            >
              <el-icon><Bottom /></el-icon>
            </el-button>
            <el-button
              type="primary" text size="small"
              @click="handleInsert(msg.id)"
            >
              立即发送
            </el-button>
            <el-button
              type="danger" text size="small"
              @click="handleDelete(msg.id)"
            >
              <el-icon><Delete /></el-icon>
            </el-button>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 折叠状态：只显示数量和最近一条 -->
    <div v-if="!expanded && queueMessages.length > 5" class="queue-collapsed">
      <span class="queue-text">{{ truncate(queueMessages[0].content, 30) }}...</span>
      <span class="queue-more">还有 {{ queueMessages.length - 1 }} 条</span>
    </div>
  </div>
</template>
```

**样式要点**：
- 位于输入框上方
- 背景色区分于消息列表
- 每条消息一行，右侧操作按钮
- 超过 5 条时折叠，显示第一条摘要 + "还有 N 条"

### 6.6 修改 ChatInput 组件

**文件**：`desktop/src/components/chat/ChatInput.vue`

修改发送逻辑：

```typescript
function handleSend() {
  if (!canSend.value) return

  // 修改：使用 sendMessageWithQueue 替代 emit('send')
  // 由 TaskView 层判断是直接发送还是入队
  emit('send', inputText.value.trim(), [...pendingFiles.value])

  inputText.value = ''
  // ... 清理逻辑不变
}
```

### 6.7 修改 TaskView

**文件**：`desktop/src/views/task/TaskView.vue`

修改 `handleSend` 方法：

```typescript
function handleSend(text: string, files: File[]) {
  // 修改：使用带队列判断的发送方法
  sendMessageWithQueue(text, files)
  nextTick(scrollToBottomSmooth)
}
```

在模板中添加 QueuePanel：

```vue
<template>
  <div class="task-view">
    <!-- 消息列表 -->
    <MessageList ... />

    <!-- 新增：队列面板 -->
    <QueuePanel />

    <!-- 输入框 -->
    <ChatInput ... />
  </div>
</template>
```

### 6.8 防并发处理

在 `QueuePanel` 组件中，对"立即发送"按钮做防抖：

```typescript
const inserting = ref(false)

async function handleInsert(queueId: string) {
  if (inserting.value) return
  inserting.value = true

  try {
    await insertQueueMessage(queueId)
  } finally {
    // 延迟重置，避免连续点击
    setTimeout(() => { inserting.value = false }, 500)
  }
}
```

---

## 7. WebSocket 事件协议

### 7.1 客户端 → 服务端

| type | 说明 | data 字段 |
|------|------|-----------|
| `enqueue_message` | 消息入队 | `sessionId`, `content`, `images`, `eventId` |
| `insert_message` | 立即发送（打断） | `sessionId`, `queueId` |
| `delete_queue_message` | 删除队列消息 | `sessionId`, `queueId` |
| `reorder_queue_message` | 调整顺序 | `sessionId`, `queueId`, `direction` |

### 7.2 服务端 → 客户端

| type | 说明 | data 字段 |
|------|------|-----------|
| `queue_updated` | 队列变更通知 | `sessionId`, `queue: [QueueMessage]` |

---

## 8. 边界情况处理

### 8.1 并发插入

**场景**：用户快速连续点击两条消息的"立即发送"。

**处理**：
- 前端防抖：500ms 内只允许一次插入操作
- 后端保证：第一条插入会先停止 Agent，第二条在第一条完成后执行
- 两条消息都不会丢失，按顺序追加到消息列表

### 8.2 队列消息发送失败

**场景**：队列消息发出后，Agent 执行失败。

**处理**：
- 消息已在发送时从队列移除
- Agent 执行失败不影响队列状态
- 失败结果显示在对话窗口

### 8.3 页面刷新

**场景**：用户刷新页面，队列消息需要恢复。

**处理**：
- 队列消息持久化在数据库中
- 前端切换 session 时，通过 REST API 或 WS 订阅获取队列列表
- 新增 REST 接口：`GET /api/v1/sessions/{id}/queue`

### 8.4 Session 切换

**场景**：用户在 Agent 执行时切换到其他 session。

**处理**：
- 队列按 sessionId 隔离，切换 session 自动切换队列
- 切换回来时重新加载队列

### 8.5 Agent 空闲时收到队列消费请求

**场景**：自动消费时，Agent 已经被其他操作启动。

**处理**：
- 在触发 handleSendMessage 前，再次检查 session phase
- 若 Agent 已在运行，将消息重新入队（不消费）

### 8.6 被打断任务的上下文保留

**场景**：Agent 执行到一半被打断。

**处理**：
- AgentLoop 检测到 cancelFlag 后退出循环
- 已执行的 assistant 消息和 tool 调用结果已通过 persistenceCallback 持久化
- 前端收到 CANCELLED 状态后，将当前 assistant 消息标记为完成
- 新消息发送时，buildContext() 会从 DB 加载完整历史（包含被打断的部分）

### 8.7 图片消息入队

**场景**：用户发送带图片的消息，Agent 忙碌时入队。

**处理**：
- 入队前先上传图片到 OSS
- 队列中存储图片 URL 数组
- 消费时直接使用 URL，无需重新上传

---

## 9. REST API 补充

### 9.1 获取队列列表

```
GET /api/v1/sessions/{sessionId}/queue
```

**响应**：
```json
{
  "code": 0,
  "data": [
    {
      "id": 1,
      "sessionId": 100,
      "content": "帮我写一个函数",
      "images": null,
      "sortOrder": 1,
      "createdAt": "2024-01-01T12:00:00"
    }
  ]
}
```

**用途**：页面刷新后恢复队列展示。

---

## 10. 实现计划

按模块划分，每个模块包含完整的前后端实现，模块间无依赖关系，可按任意顺序实现。

### 模块 A：数据层与基础服务

**涉及文件**：
- 新增：`V032__add_message_queue.sql`
- 新增：`MessageQueue.java`、`MessageQueueMapper.java`、`MessageQueueService.java`
- 新增：`GET /api/v1/sessions/{id}/queue` REST 接口

**实现内容**：
1. 数据库迁移脚本
2. 实体类与 Mapper
3. MessageQueueService 核心方法（enqueue、dequeue、delete、reorder、listPending、clear）
4. REST 接口（页面刷新后恢复队列）

**完成标志**：可通过 REST 接口完成队列的增删查改操作。

---

### 模块 B：WebSocket 协议与后端逻辑

**涉及文件**：
- 修改：`StreamingWsHandler.java`

**实现内容**：
1. 新增事件处理：`enqueue_message`、`insert_message`、`delete_queue_message`、`reorder_queue_message`
2. 自动消费逻辑（在 agentExecutor 完成回调中，检查队列并触发下一条消息）
3. 消息插入逻辑（设置 cancelFlag → 等待 Agent 停止 → 从队列移除 → 触发 handleSendMessage）
4. 发送 `queue_updated` 事件通知前端

**完成标志**：通过 WebSocket 客户端工具可完成队列操作，自动消费和插入打断流程正常。

---

### 模块 C：前端状态与通信层

**涉及文件**：
- 修改：`desktop/src/types/chat.ts`
- 修改：`desktop/src/stores/session.ts`
- 修改：`desktop/src/composables/useChat.ts`
- 修改：`desktop/src/composables/useStreamWS.ts`

**实现内容**：
1. `QueueMessage` 类型定义
2. sessionStore 新增队列状态（`sessionQueueMessages`、`activeQueueMessages`）和方法（`setQueueMessages`、`clearQueue`）
3. useChat 新增 `sendMessageWithQueue`（带队列判断）、`enqueueMessage`、`insertQueueMessage`、`deleteQueueMessage`、`reorderQueueMessage`
4. useStreamWS 新增 WS 发送方法和 `queue_updated` 事件处理

**完成标志**：前端可通过 composable 方法完成队列操作，Store 状态正确更新。

---

### 模块 D：前端 UI 组件

**涉及文件**：
- 新增：`desktop/src/components/chat/QueuePanel.vue`
- 修改：`desktop/src/views/task/TaskView.vue`
- 修改：`desktop/src/components/chat/ChatInput.vue`

**实现内容**：
1. QueuePanel 组件（队列列表、上下排序、删除、立即发送、折叠/展开）
2. TaskView 集成 QueuePanel（位于输入框上方）
3. ChatInput 发送逻辑修改（使用 `sendMessageWithQueue` 替代直接 `emit('send')`）
4. 防并发处理（"立即发送"按钮 500ms 防抖）

**完成标志**：UI 完整展示，所有交互可操作。

---

### 模块 E：端到端联调

**涉及文件**：无新增，验证所有模块协同工作

**验证项**：
1. Agent 空闲时发送消息 → 直接执行（不进队列）
2. Agent 忙碌时发送消息 → 进入队列 → 队列面板显示
3. Agent 完成 → 自动消费队列头部消息
4. 点击"立即发送" → 打断当前 Agent → 执行选中消息
5. 队列排序（上下箭头）→ 顺序正确
6. 队列删除 → 消息移除
7. 超过 5 条 → 折叠展示
8. 页面刷新 → 队列恢复
9. 被打断任务上下文保留在对话窗口
10. 快速连续点击"立即发送" → 防并发生效，消息不丢失

---

## 11. 附录：关键文件索引

| 文件 | 说明 |
|------|------|
| `backend/.../session/entity/MessageQueue.java` | 新增：队列消息实体 |
| `backend/.../session/mapper/MessageQueueMapper.java` | 新增：队列 Mapper |
| `backend/.../session/service/MessageQueueService.java` | 新增：队列服务 |
| `backend/.../session/service/SessionService.java` | 修改：updatePhase 增加自动消费钩子 |
| `backend/.../session/ws/StreamingWsHandler.java` | 修改：新增事件处理 |
| `backend/.../resources/db/migration/V032__add_message_queue.sql` | 新增：迁移脚本 |
| `desktop/src/types/chat.ts` | 修改：新增 QueueMessage 类型 |
| `desktop/src/stores/session.ts` | 修改：新增队列状态管理 |
| `desktop/src/composables/useChat.ts` | 修改：新增队列相关方法 |
| `desktop/src/composables/useStreamWS.ts` | 修改：新增 WS 事件处理 |
| `desktop/src/components/chat/QueuePanel.vue` | 新增：队列面板组件 |
| `desktop/src/views/task/TaskView.vue` | 修改：集成 QueuePanel |
| `desktop/src/components/chat/ChatInput.vue` | 修改：发送逻辑调整 |
