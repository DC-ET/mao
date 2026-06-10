# 文件变更追踪 — 技术设计文档

## 1. 需求概述

Agent 执行任务过程中，通过 `write_file`、`edit_file` 工具对工作区文件进行创建/修改。用户无法从对话页面快速感知哪些文件发生了变化。

**目标**：
- 每轮对话（用户发消息 → Agent 执行完毕）记录 Agent 产生的文件变更列表
- 持久化到数据库，支持历史回显
- 实时通过 WebSocket 推送变更事件，UI 边跑边展示
- 每个文件展示变更类型（新建/修改）和行级统计（新增行数、删除行数）

## 2. 整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        后端 (Spring Boot)                        │
│                                                                 │
│  AgentLoop.executeToolCalls()                                   │
│       │                                                         │
│       ▼                                                         │
│  ToolDispatcher.dispatch()                                      │
│       │                                                         │
│       ├─ WriteFileTool.execute()  ─┐                            │
│       │                            ├─► FileChangeTracker        │
│       └─ EditFileTool.execute()  ─┘     (per-session, memory)   │
│                                           │                     │
│                                           ▼                     │
│                                    WsStreamingEventListener     │
│                                    onToolCallResult()           │
│                                           │                     │
│                                           ├─► WS: file_change  │
│                                           │                     │
│                                           ▼                     │
│                                    SessionService               │
│                                    saveFileChanges()            │
│                                           │                     │
│                                           ▼                     │
│                                    DB: message_file_change      │
└─────────────────────────────────────────────────────────────────┘
         │ WS: file_change                    │ GET /messages
         ▼                                    ▼
┌─────────────────────┐            ┌──────────────────────┐
│  实时流 (streaming)  │            │  历史回显 (fetch)     │
│  store 追加变更条目   │            │  API 返回变更列表     │
└─────────────────────┘            └──────────────────────┘
```

## 3. 数据库设计

### 3.1 新建表 `message_file_change`

关联粒度：**每条 ASSISTANT 消息**。一轮对话产生一条 ASSISTANT 消息（可能包含多次工具调用），该消息的所有文件变更聚合存储。

```sql
-- V037__add_message_file_change.sql
CREATE TABLE message_file_change (
    id           BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    message_id   BIGINT       NOT NULL COMMENT '关联的 ASSISTANT 消息 ID',
    session_id   BIGINT       NOT NULL COMMENT '冗余 session_id，便于按会话查询',
    file_path    VARCHAR(512) NOT NULL COMMENT '相对于工作区的文件路径',
    change_type  VARCHAR(16)  NOT NULL COMMENT 'CREATED / MODIFIED',
    lines_added  INT          NOT NULL DEFAULT 0 COMMENT '新增行数',
    lines_deleted INT         NOT NULL DEFAULT 0 COMMENT '删除行数',
    created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_message_id (message_id),
    INDEX idx_session_id (session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**设计决策**：
- `message_id` 关联到 ASSISTANT 消息，而非 USER 消息。原因：ASSISTANT 消息在 Agent 执行完毕后由 `persistenceCallback.onSaveAssistantMessage()` 创建，此时所有工具调用已完成，可以一次性写入该轮所有变更。
- 同一轮对话中对同一文件的多次编辑，合并为一条记录（累加 `lines_added` / `lines_deleted`）。
- `change_type` 只区分 `CREATED`（文件之前不存在）和 `MODIFIED`（文件已存在）。`write_file` 覆盖已有文件视为 `MODIFIED`。
- 不追踪 `shell` 工具产生的文件变更（无法可靠解析）。

### 3.2 不修改现有表

`message` 表的 `metadata` JSON 字段可以存引用信息，但变更记录本身独立建表更清晰，查询也更高效。

## 4. 后端实现

### 4.1 新增实体与 Mapper

**`FileChange` 实体** — `backend/src/main/java/com/agentworkbench/session/entity/FileChange.java`

```java
@Data
@TableName("message_file_change")
public class FileChange {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long messageId;
    private Long sessionId;
    private String filePath;
    private String changeType;   // CREATED / MODIFIED
    private Integer linesAdded;
    private Integer linesDeleted;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
```

**`FileChangeMapper`** — `backend/src/main/java/com/agentworkbench/session/mapper/FileChangeMapper.java`

```java
@Mapper
public interface FileChangeMapper extends BaseMapper<FileChange> {
}
```

### 4.2 工具层：采集变更信息

核心思路：在 `WriteFileTool` 和 `EditFileTool` 的 `execute()` 方法中，执行文件写入前后对比，计算变更统计，将结果附带在工具返回的 JSON 中。

#### WriteFileTool 改动

在现有返回 JSON 中新增 `file_change` 字段：

```java
// 写入前检查文件是否已存在
boolean fileExisted = Files.exists(filePath);
int oldLineCount = 0;
if (fileExisted) {
    oldLineCount = Files.readAllLines(filePath).size();
}

Files.writeString(filePath, content);

int newLineCount = content.isEmpty() ? 0 : content.split("\n", -1).length;
int linesAdded = fileExisted ? Math.max(0, newLineCount - oldLineCount) : newLineCount;
int linesDeleted = fileExisted ? Math.max(0, oldLineCount - newLineCount) : 0;
String changeType = fileExisted ? "MODIFIED" : "CREATED";

return objectMapper.writeValueAsString(Map.of(
    "success", true,
    "bytes_written", content.length(),
    "file_change", Map.of(
        "path", path,
        "type", changeType,
        "lines_added", linesAdded,
        "lines_deleted", linesDeleted
    )
));
```

#### EditFileTool 改动

编辑工具已有 `old_string` / `new_string`，可以直接计算行数差：

```java
int oldLines = oldString.split("\n", -1).length;
int newLines = newString.split("\n", -1).length;
int linesAdded = Math.max(0, (newLines - oldLines) * replacements);
int linesDeleted = Math.max(0, (oldLines - newLines) * replacements);

return objectMapper.writeValueAsString(Map.of(
    "success", true,
    "replacements", replacements,
    "file_change", Map.of(
        "path", path,
        "type", "MODIFIED",
        "lines_added", linesAdded,
        "lines_deleted", linesDeleted
    )
));
```

### 4.3 WsStreamingEventListener：解析变更并通过 WebSocket 推送

在 `onToolCallResult()` 方法中，解析工具返回的 `file_change` 字段，发送 `file_change` 事件：

```java
// 在 onToolCallResult() 方法内，activity 记录之后追加：

if ("write_file".equals(toolName) || "edit_file".equals(toolName)) {
    try {
        JsonNode resultNode = objectMapper.readTree(result);
        if (resultNode.has("file_change") && resultNode.get("success").asBoolean()) {
            JsonNode fc = resultNode.get("file_change");
            Map<String, Object> changeData = new LinkedHashMap<>();
            changeData.put("path", fc.get("path").asText());
            changeData.put("type", fc.get("type").asText());
            changeData.put("lines_added", fc.get("lines_added").asInt());
            changeData.put("lines_deleted", fc.get("lines_deleted").asInt());
            changeData.put("tool_call_id", toolCallId);
            send("file_change", changeData);
        }
    } catch (Exception e) {
        log.debug("Failed to parse file_change from tool result", e);
    }
}
```

### 4.4 持久化：在 ASSISTANT 消息保存时写入

改动点：`HarnessService` 中的 `MessagePersistenceCallback.onSaveAssistantMessage()`。

当前流程：AgentLoop 每轮执行完所有工具调用后，调用 `persistenceCallback.onSaveAssistantMessage()` 保存 ASSISTANT 消息。

新增逻辑：在保存 ASSISTANT 消息后，解析该轮所有工具调用的结果，提取 `file_change`，批量写入 `message_file_change` 表。

```java
// HarnessService.execute() 中的 persistenceCallback 改动：

@Override
public void onSaveAssistantMessage(String content, String thinkingContent,
                                    List<ChatRequest.ToolCall> toolCalls, ChatUsage usage) {
    // ... 现有保存逻辑 ...
    Message savedMsg = sessionService.saveMessage(sessionId, "ASSISTANT", content,
            thinkingContent, null, toolCallsJson, tokenCount, modelId);

    // 新增：保存文件变更记录
    if (toolCalls != null && !toolCalls.isEmpty()) {
        saveFileChanges(savedMsg.getId(), sessionId, toolCalls);
    }
}
```

`saveFileChanges` 方法：遍历所有工具调用，从结果 JSON 中提取 `file_change`，按文件路径合并后批量插入。

```java
private void saveFileChanges(Long messageId, Long sessionId, List<ChatRequest.ToolCall> toolCalls) {
    // 按文件路径合并变更
    Map<String, FileChange> merged = new LinkedHashMap<>();

    for (ChatRequest.ToolCall tc : toolCalls) {
        String toolName = tc.getFunction().getName();
        if (!"write_file".equals(toolName) && !"edit_file".equals(toolName)) continue;

        String result = /* 从 tool result 中获取 */;
        // 注意：此时 toolCalls 的 summary 已设置，但 result 需要从 AgentLoop 传递
        // 方案：扩展 MessagePersistenceCallback，将工具结果一并传入
    }

    // 批量插入
    for (FileChange fc : merged.values()) {
        fileChangeMapper.insert(fc);
    }
}
```

**关键问题**：当前 `onSaveAssistantMessage` 只接收 `toolCalls`（包含 id/name/arguments/summary），不包含每个工具的执行结果。需要将工具结果一并传递。

**解决方案**：扩展 `MessagePersistenceCallback` 接口：

```java
interface MessagePersistenceCallback {
    void onSaveAssistantMessage(String content, String thinkingContent,
                                 List<ChatRequest.ToolCall> toolCalls, ChatUsage usage);
    void onSaveToolMessage(String toolCallId, String content);

    // 新增：带工具结果的保存方法
    default void onSaveAssistantMessage(String content, String thinkingContent,
                                         List<ChatRequest.ToolCall> toolCalls,
                                         Map<String, String> toolResults, ChatUsage usage) {
        onSaveAssistantMessage(content, thinkingContent, toolCalls, usage);
    }
}
```

在 `AgentLoop.executeToolCalls()` 中，收集 `{toolCallId -> result}` 映射，在保存 ASSISTANT 消息时传入。

### 4.5 AgentLoop 改动

在 `executeToolCalls()` 中维护一个 `Map<String, String> toolResults`，收集每次工具调用的结果：

```java
private void executeToolCalls(List<ChatRequest.ToolCall> pendingCalls,
                               AgentExecutionContext context,
                               AgentEventListener listener,
                               MessagePersistenceCallback persistenceCallback) {
    Map<String, String> toolResults = new LinkedHashMap<>();

    if (pendingCalls.size() == 1) {
        // ... 现有逻辑 ...
        toolResults.put(tc.getId(), result);
    } else {
        // ... 现有并行逻辑 ...
        for (int i = 0; i < pendingCalls.size(); i++) {
            toolResults.put(pendingCalls.get(i).getId(), results[i]);
        }
    }

    // 传递 toolResults 给 persistenceCallback
    // 在延迟保存 assistant 消息时使用带 toolResults 的重载方法
}
```

### 4.6 SessionController：消息 API 返回变更记录

改动 `getMessages` 端点，在返回 `MessageVO` 时附带关联的文件变更：

```java
// SessionController.java

@GetMapping("/{id}/messages")
public Result<List<MessageVO>> getMessages(...) {
    List<MessageVO> messages = sessionService.getMessages(id).stream()
            .map(this::toMessageVO)
            .collect(Collectors.toList());

    // 批量查询该会话所有文件变更，按 messageId 分组
    Map<Long, List<FileChange>> changesByMsg = sessionService.getFileChangesBySession(id);

    for (MessageVO vo : messages) {
        List<FileChange> changes = changesByMsg.get(vo.getId());
        if (changes != null && !changes.isEmpty()) {
            vo.setFileChanges(changes.stream()
                    .map(this::toFileChangeVO)
                    .collect(Collectors.toList()));
        }
    }

    return Result.success(messages);
}
```

`MessageVO` 新增字段：

```java
@Data
public static class MessageVO {
    // ... 现有字段 ...
    private List<FileChangeVO> fileChanges;

    @Data
    public static class FileChangeVO {
        private String path;
        private String type;         // CREATED / MODIFIED
        private int linesAdded;
        private int linesDeleted;
    }
}
```

## 5. WebSocket 事件

### 5.1 新增事件类型 `file_change`

**方向**：Server → Client

**触发时机**：每次 `write_file` 或 `edit_file` 工具执行成功后

**数据结构**：

```json
{
    "type": "file_change",
    "sessionId": 123,
    "data": {
        "path": "src/main/App.java",
        "type": "MODIFIED",
        "lines_added": 15,
        "lines_deleted": 3,
        "tool_call_id": "call_abc123"
    }
}
```

**字段说明**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `path` | string | 相对于工作区的文件路径 |
| `type` | string | `CREATED` 或 `MODIFIED` |
| `lines_added` | int | 新增行数 |
| `lines_deleted` | int | 删除行数 |
| `tool_call_id` | string | 关联的工具调用 ID |

## 6. 前端实现

### 6.1 类型定义

**`desktop/src/types/chat.ts`** 新增：

```typescript
export interface FileChange {
  path: string
  type: 'CREATED' | 'MODIFIED'
  linesAdded: number
  linesDeleted: number
  toolCallId?: string
}
```

**`ChatMessage` 接口** 新增可选字段：

```typescript
export interface ChatMessage {
  // ... 现有字段 ...
  fileChanges?: FileChange[]
}
```

### 6.2 Session Store 改动

**`desktop/src/stores/session.ts`**：

新增 per-session 的变更缓存 Map：

```typescript
const sessionFileChanges = ref<Map<string, FileChange[]>>(new Map())
```

新增 mutation 方法：

```typescript
function appendFileChange(sessionId: string, change: FileChange) {
  const changes = sessionFileChanges.value.get(sessionId) || []
  // 合并同文件的变更
  const existing = changes.find(c => c.path === change.path)
  if (existing) {
    existing.linesAdded += change.linesAdded
    existing.linesDeleted += change.linesDeleted
    if (change.type === 'CREATED') existing.type = 'CREATED'
  } else {
    changes.push({ ...change })
  }
  sessionFileChanges.value.set(sessionId, [...changes])
}

function setFileChanges(sessionId: string, changes: FileChange[]) {
  sessionFileChanges.value.set(sessionId, changes)
}

function clearFileChanges(sessionId: string) {
  sessionFileChanges.value.delete(sessionId)
}
```

新增 computed：

```typescript
const activeFileChanges = computed(() =>
  activeSessionId.value
    ? sessionFileChanges.value.get(activeSessionId.value) || []
    : []
)
```

### 6.3 WebSocket 事件处理

**`desktop/src/composables/useStreamWS.ts`** 的 `routeEvent()` 中新增：

```typescript
case 'file_change':
  sessionStore.appendFileChange(sessionId, {
    path: data.path,
    type: data.type,
    linesAdded: data.lines_added,
    linesDeleted: data.lines_deleted,
    toolCallId: data.tool_call_id
  })
  break
```

### 6.4 消息回显处理

在 `useChat.ts` 的 `fetchMessages()` 中，从 API 返回的 `MessageVO` 中提取 `fileChanges`，挂载到对应的 `ChatMessage` 上：

```typescript
// mapApiMessagesToChat() 或 fetchMessages() 中处理
// API 返回的 MessageVO 已包含 fileChanges 字段
// 在 ChatMessage 上附加 fileChanges 属性
```

同时，在 `fetchMessages()` 完成后，将该会话所有消息的 `fileChanges` 聚合到 store 中，供 UI 全局展示：

```typescript
async function fetchMessages() {
  // ... 现有逻辑 ...
  const allChanges: FileChange[] = []
  for (const msg of mappedMessages) {
    if (msg.fileChanges) {
      allChanges.push(...msg.fileChanges)
    }
  }
  sessionStore.setFileChanges(sessionId.value, allChanges)
}
```

### 6.5 UI 组件：FileChangePanel

新建组件 **`desktop/src/components/chat/FileChangePanel.vue`**。

**展示位置**：在对话消息列表的底部（或作为 MessageBubble 的子组件，挂在每条 ASSISTANT 消息下方）。

**展示形式**：折叠面板，默认展开（当有变更时），展示文件变更列表。

**每个文件条目**：

```
┌──────────────────────────────────────────────────────┐
│  文件变更 (5)                            [展开/折叠]  │
├──────────────────────────────────────────────────────┤
│  📄 src/main/App.java           MODIFIED             │
│     +15  -3                                          │
│  📄 src/utils/helper.java       CREATED              │
│     +42  -0                                          │
│  📄 pom.xml                     MODIFIED             │
│     +2   -1                                          │
└──────────────────────────────────────────────────────┘
```

**组件 Props**：

```typescript
interface Props {
  changes: FileChange[]
  mode: 'realtime' | 'history'  // 实时模式逐条追加，历史模式一次性展示
}
```

**样式要点**：
- 使用 Element Plus 的 `ElCollapse` 或自定义折叠
- 文件路径过长时截断并显示 tooltip
- `CREATED` 类型用绿色标记，`MODIFIED` 用蓝色/橙色标记
- 行数统计用 `+N`（绿色）/ `-N`（红色）的 diff 风格展示

### 6.6 集成到 MessageBubble

在 `MessageBubble.vue` 中，当 `message.fileChanges` 非空时，在消息内容下方渲染 `<FileChangePanel>`：

```vue
<!-- MessageBubble.vue template 中，toolCalls 渲染之后 -->
<FileChangePanel
  v-if="message.fileChanges?.length"
  :changes="message.fileChanges"
  mode="history"
/>
```

### 6.7 实时模式的全局面板

在对话页面的侧边栏或消息列表顶部，展示当前会话的累计变更汇总（来自 store 中的 `sessionFileChanges`）。当 Agent 正在执行时，每收到 `file_change` 事件就实时更新。

这个全局面板可以放在：
- TaskIndexPanel 中当前 session 的详情区域
- 或对话区域顶部的折叠条

具体位置由 UI 设计决定，技术上只需读取 `store.activeFileChanges` 即可。

## 7. 数据流时序

### 7.1 实时流

```
用户发送消息
  │
  ▼
AgentLoop 开始执行
  │
  ├─ LLM 返回 tool_call: write_file(path="A.java", content="...")
  │
  ▼
AgentLoop.executeToolCalls()
  │
  ├─ WriteFileTool.execute()
  │   ├─ 对比文件是否存在，计算行数差
  │   └─ 返回 { success: true, bytes_written: 100, file_change: {...} }
  │
  ├─ WsStreamingEventListener.onToolCallResult()
  │   ├─ 发送 tool_call_result 事件（现有）
  │   ├─ 记录 activity（现有）
  │   └─ 解析 file_change，发送 file_change 事件（新增）
  │
  ▼
前端 useStreamWS.routeEvent()
  │
  ├─ case 'tool_call_result': 更新 ToolCall 状态（现有）
  └─ case 'file_change': appendFileChange 到 store（新增）
  │
  ▼
UI 实时更新 FileChangePanel
```

### 7.2 历史回显

```
用户打开历史会话
  │
  ▼
useChat.fetchMessages()
  │
  ├─ GET /api/v1/sessions/{id}/messages
  │   └─ 返回 MessageVO[]，每个 ASSISTANT 消息包含 fileChanges[]
  │
  ├─ mapApiMessagesToChat() 转换为 ChatMessage[]
  │   └─ 每个 ChatMessage 挂载 fileChanges
  │
  └─ 聚合所有 fileChanges 到 store（供全局面板使用）
  │
  ▼
MessageBubble 渲染 FileChangePanel (mode="history")
```

## 8. Crash Recovery 兼容

当前 `SessionService.cleanupIncompleteTail()` 会删除不完整的消息序列。`message_file_change` 通过 `message_id` 关联，当 ASSISTANT 消息被删除时，对应的变更记录也应级联删除。

方案：在 `cleanupIncompleteTail()` 删除消息时，同步删除关联的 `message_file_change` 记录。由于使用 MyBatis-Plus，可以通过 `ON DELETE CASCADE` 外键约束实现（推荐），或在删除消息后手动清理。

```sql
-- 在 V037 迁移中添加外键约束
ALTER TABLE message_file_change
    ADD CONSTRAINT fk_mfc_message
    FOREIGN KEY (message_id) REFERENCES message(id)
    ON DELETE CASCADE;
```

## 9. 上下文压缩兼容

`CompactionService` 压缩历史消息时，会将旧消息替换为摘要 SYSTEM 消息。被删除的消息对应的 `message_file_change` 记录会因外键级联删除自动清理。

这是合理的行为：压缩后的会话不需要保留早期轮次的文件变更详情。

## 10. 文件清单

### 后端新增文件
- `backend/src/main/java/com/agentworkbench/session/entity/FileChange.java`
- `backend/src/main/java/com/agentworkbench/session/mapper/FileChangeMapper.java`
- `backend/src/main/resources/db/migration/V037__add_message_file_change.sql`

### 后端修改文件
- `backend/.../harness/tool/impl/WriteFileTool.java` — 返回 file_change
- `backend/.../harness/tool/impl/EditFileTool.java` — 返回 file_change
- `backend/.../harness/core/AgentLoop.java` — 收集 toolResults，扩展 persistenceCallback 调用
- `backend/.../harness/core/HarnessService.java` — persistenceCallback 实现中保存 file_change
- `backend/.../session/ws/WsStreamingEventListener.java` — 解析并推送 file_change 事件
- `backend/.../session/controller/SessionController.java` — MessageVO 增加 fileChanges
- `backend/.../session/service/SessionService.java` — 新增 getFileChangesBySession / saveFileChanges

### 前端新增文件
- `desktop/src/components/chat/FileChangePanel.vue`

### 前端修改文件
- `desktop/src/types/chat.ts` — 新增 FileChange 接口，ChatMessage 增加 fileChanges
- `desktop/src/stores/session.ts` — 新增 sessionFileChanges Map 和相关 mutation
- `desktop/src/composables/useStreamWS.ts` — routeEvent 处理 file_change
- `desktop/src/composables/useChat.ts` — fetchMessages 中聚合 fileChanges
- `desktop/src/components/chat/MessageBubble.vue` — 渲染 FileChangePanel
