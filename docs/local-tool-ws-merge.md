# Local Tool WS 合并到 Streaming WS 技术方案

## 1. 背景与问题

桌面客户端当前维护两条 WebSocket 连接：

| 连接 | 端点 | 作用 | 生命周期 |
|------|------|------|----------|
| Streaming WS | `/ws/stream` | 推送对话消息、Agent 执行事件 | 全局单例，切换会话只发 subscribe/unsubscribe |
| Local Tool WS | `/ws/local-tool` | 本地工具执行请求/响应（Bash 审批、文件操作等） | 每次切换会话断开重连 |

切换会话时 Local Tool WS 必须断开重连（后端按 sessionId 绑定连接），导致用户看到"本地执行连接已断开，正在重连..."的误报提示。且当前设计下，切走到其他会话后，旧会话的 Agent 如需本地工具调用，因连接已断会直接失败。

## 2. 目标

- 消除 Local Tool WS，所有消息统一走 Streaming WS（单连接）
- 切换会话不再断连，无感切换
- 非活跃会话的本地工具调用正常执行
- 需审批的工具调用（如 Bash）在非活跃会话时延迟展示，用户切回时回显

## 3. 架构变更总览

```
变更前：
  渲染进程 ── /ws/stream ──► StreamingWsHandler (消息/事件)
  Electron main ── /ws/local-tool ──► LocalToolWebSocketHandler (工具执行)

变更后：
  渲染进程 ── /ws/stream ──► StreamingWsHandler (消息/事件 + 工具执行)
                              │
                              ├─ tool_execute (下行): 服务端 → 客户端
                              ├─ tool_result (上行): 客户端 → 服务端
                              └─ tool_error (上行): 客户端 → 服务端
```

## 4. 后端改动

### 4.1 废弃 LocalToolWebSocketHandler

删除 `LocalToolWebSocketHandler.java`，移除 WebSocket 配置中 `/ws/local-tool` 端点注册。

### 4.2 改造 LocalToolSessionRegistry

当前 registry 是 sessionId → WebSocketSession 映射。合并后不再持有连接，改为 sessionId → userId 映射，通过 StreamingWsRegistry 发送消息。

```java
// 变更前
private final ConcurrentHashMap<Long, LocalToolConnection> connections = new ConcurrentHashMap<>();

// 变更后：sessionId → userId（用于路由工具请求）
private final ConcurrentHashMap<Long, Long> sessionUsers = new ConcurrentHashMap<>();
// sessionId → requestId → CompletableFuture（保持不变）
private final ConcurrentHashMap<Long, ConcurrentHashMap<String, CompletableFuture<String>>> pendingRequests = new ConcurrentHashMap<>();
```

关键方法变更：

- `register(sessionId, userId)` — 记录 sessionId → userId 映射，不再持有 WebSocketSession
- `unregister(sessionId)` — 清除映射，failAllPending 不变
- `sendToolRequest(sessionId, toolName, arguments, workspace)` — 通过 StreamingWsRegistry.send(userId, event) 发送 `tool_execute` 消息
- `completeToolRequest(sessionId, requestId, result)` — 不变
- `completeToolRequestError(sessionId, requestId, error)` — 不变
- `isConnected(sessionId)` — 检查 sessionUsers 中是否存在该 sessionId 且 StreamingWsRegistry.hasConnection(userId) 为 true
- 新增 `setUserForSession(sessionId, userId)` — 由 StreamingWsHandler 在 LOCAL 模式会话启动时调用
- 新增 `getUserIdForSession(sessionId)` — 返回关联的 userId

### 4.3 StreamingWsHandler 新增消息类型

在 `handleTextMessage` 的 switch 中新增：

```java
case "tool_result" -> handleToolResult(userId, root);
case "tool_error" -> handleToolError(userId, root);
```

```java
private void handleToolResult(Long userId, JsonNode root) {
    Long sessionId = getLong(root, "sessionId");
    String requestId = root.get("requestId").asText();
    String result = root.has("result") ? root.get("result").toString() : "{}";
    if (sessionId != null) {
        localToolSessionRegistry.completeToolRequest(sessionId, requestId, result);
    }
}

private void handleToolError(Long userId, JsonNode root) {
    Long sessionId = getLong(root, "sessionId");
    String requestId = root.get("requestId").asText();
    String error = root.has("error") ? root.get("error").asText() : "Unknown error";
    if (sessionId != null) {
        localToolSessionRegistry.completeToolRequestError(sessionId, requestId, error);
    }
}
```

### 4.4 LOCAL 模式会话启动时注册 userId

在 `handleSendMessage` 中，Agent 提交执行前，对 LOCAL 模式会话调用：

```java
if ("LOCAL".equals(session.getExecutionMode())) {
    localToolSessionRegistry.setUserForSession(sessionId, userId);
    // ... 原有的 isConnected 检查改为走新逻辑
}
```

### 4.5 StreamingWsHandler 连接断开处理

`afterConnectionClosed` 中，当用户连接断开时，需要 failAllPending 该用户所有关联 session 的 pending 请求：

```java
@Override
public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
    Long userId = registry.getUserId(session);
    if (userId != null) {
        localToolSessionRegistry.failAllForUser(userId);
    }
    registry.unregister(session);
}
```

### 4.6 LocalToolSessionRegistry 发送逻辑

```java
public CompletableFuture<String> sendToolRequest(Long sessionId, String toolName, String arguments, String workspace) {
    Long userId = sessionUsers.get(sessionId);
    if (userId == null || !streamingWsRegistry.hasConnection(userId)) {
        CompletableFuture<String> f = new CompletableFuture<>();
        f.complete("{\"error\":\"Local client is not connected\"}");
        return f;
    }

    String requestId = UUID.randomUUID().toString();
    CompletableFuture<String> future = new CompletableFuture<>();
    pendingRequests.computeIfAbsent(sessionId, k -> new ConcurrentHashMap<>()).put(requestId, future);

    // 通过 StreamingWsRegistry 发送，带上 sessionId 用于客户端路由
    streamingWsRegistry.send(userId, WsEvent.of("tool_execute", sessionId, Map.of(
        "requestId", requestId,
        "toolName", toolName,
        "arguments", arguments != null ? arguments : "{}",
        "workspace", workspace != null ? workspace : ""
    )));

    return future;
}
```

## 5. Electron 主进程改动

### 5.1 移除 Local Tool WS 连接管理

删除 `main.cjs` 中以下内容：
- `wsClient` 变量及相关状态（`wsReconnectTimer`, `wsPingInterval`, `wsExplicitDisconnect`）
- `ws-connect` IPC handler
- `ws-disconnect` IPC handler
- `connectWebSocket()` 函数
- `requestBashApproval()` 函数（保留，但触发方式变更）

### 5.2 工具执行改为 IPC 调用

原来工具执行由 WS `tool_execute` 消息触发，改为由渲染进程通过 IPC 调用。

保留所有 `local-*` IPC handler（`local-execute-bash`, `local-read-file`, `local-write-file`, `local-edit-file`, `local-http-request`）不变。

Bash 审批流程保持不变：main process 通过 `bash-approval-request` 通知渲染进程，渲染进程通过 `bash-approval-response` IPC 返回结果。

### 5.3 新增 tool-execute IPC handler

```javascript
ipcMain.handle('tool-execute', async (event, { toolName, args, requestId }) => {
  try {
    let result
    switch (toolName) {
      case 'bash': result = await handleBashFromWebSocket(args); break
      case 'shell': result = await handleShellFromWebSocket(args); break
      case 'read_file': result = await handleLocalReadFile(args); break
      case 'write_file': result = await handleLocalWriteFile(args); break
      case 'edit_file': result = await handleLocalEditFile(args); break
      case 'http_request': result = await handleLocalHttpRequest(args); break
      default: result = { error: `Unknown tool: ${toolName}` }
    }
    return { requestId, result: JSON.stringify(result) }
  } catch (e) {
    return { requestId, error: e.message }
  }
})
```

## 6. Preload 桥接改动

`preload.cjs` 新增：

```javascript
// 移除
// connectLocalSession, disconnectLocalSession, onWsConnectionChange, removeWsConnectionChangeListener

// 新增
toolExecute: (toolName, args, requestId) =>
  ipcRenderer.invoke('tool-execute', { toolName, args, requestId }),
```

保留 Bash 审批相关 API 不变（`onBashApprovalRequest`, `respondBashApproval` 等）。

## 7. 渲染进程改动

### 7.1 useStreamWS.ts — 新增工具消息处理

在 `routeEvent` 中新增：

```typescript
case 'tool_execute': {
  if (sessionId) {
    // 通过 IPC 调用 Electron main process 执行工具
    const { requestId, toolName, arguments: args, workspace } = data
    handleLocalToolExecute(sessionId, requestId, toolName, args, workspace)
  }
  break
}
```

新增 `handleLocalToolExecute` 函数：

```typescript
async function handleLocalToolExecute(
  sessionId: string, requestId: string, toolName: string, args: string, workspace: string
) {
  const isElectron = typeof window !== 'undefined' && (window as any).electronAPI
  if (!isElectron) return

  try {
    let parsedArgs = typeof args === 'string' ? JSON.parse(args) : args
    if (workspace) parsedArgs.workdir = workspace

    const result = await (window as any).electronAPI.toolExecute(toolName, parsedArgs, requestId)

    // 将结果通过 WS 发回服务端
    if (result.error) {
      send({ type: 'tool_error', sessionId: Number(sessionId), requestId, error: result.error })
    } else {
      send({ type: 'tool_result', sessionId: Number(sessionId), requestId, result: result.result })
    }
  } catch (e: any) {
    send({ type: 'tool_error', sessionId: Number(sessionId), requestId, error: e.message })
  }
}
```

### 7.2 useChat.ts — 大幅简化

删除以下内容：
- `explicitDisconnect` 变量
- `connectLocalWebSocket()` 函数
- `setupBashApprovalListener()` 函数中的 WS 连接相关逻辑
- `newSession()` 中的 WS 断连逻辑
- `restoreSession()` 中的 `connectLocalWebSocket` 调用
- `cleanup()` 中的 WS 断连逻辑
- `wsConnected` ref

Bash 审批监听改为全局初始化一次（在 useStreamWS 或 app 启动时），不再跟 session 绑定。

`restoreSession()` 简化为：

```typescript
function restoreSession(sessionIdVal: string, mode: string, initialWorkspace?: string) {
  if (sessionId.value && sessionId.value !== sessionIdVal) {
    unsubscribe(sessionId.value)
  }
  sessionId.value = sessionIdVal
  executionMode.value = mode
  if (initialWorkspace) workspace.value = initialWorkspace
  sessionStore.setActiveSession(sessionIdVal)
  subscribe(sessionIdVal)
  fetchMessages()
  fetchTodos()
  // 不再需要 connectLocalWebSocket
}
```

`sendMessage()` 中首次创建 LOCAL 会话时，不再调用 `connectLocalWebSocket`，改为在 subscribe 后由服务端在 `handleSendMessage` 中自动注册 userId。

### 7.3 session store — 新增待审批状态追踪

在 session store 中新增：

```typescript
// sessionId → 是否有待审批的工具调用
const pendingToolApprovals = ref<Map<string, boolean>>(new Map())
```

### 7.4 task list — 黄色圆点指示器

`TaskIndexPanel.vue` 中，任务标题后增加指示器：

```vue
<span
  v-if="sessionStore.pendingToolApprovals.get(session.id)"
  class="pending-indicator"
/>
```

```css
.pending-indicator {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #e6a23c;
  margin-left: 6px;
  vertical-align: middle;
}
```

## 8. 审批消息的路由与回显

### 8.1 非活跃会话的工具执行

服务端发送 `tool_execute` 消息时带 `sessionId`。渲染进程的 `handleLocalToolExecute` 无论当前是否在该会话页面，都会执行并返回结果（无需审批的工具直接执行，需审批的走 Bash 审批流程）。

### 8.2 Bash 审批的跨会话处理

Bash 审批流程：

1. 服务端发送 `tool_execute`（toolName=bash），带 sessionId
2. 渲染进程收到后，调用 `electronAPI.toolExecute('bash', args, requestId)`
3. Electron main process 的 `handleBashFromWebSocket` 调用 `requestBashApproval(command)`
4. `requestBashApproval` 通过 `bash-approval-request` IPC 通知渲染进程
5. 渲染进程收到审批请求时：
   - 如果当前在该 sessionId 的会话页面：直接弹出审批弹窗（现有逻辑）
   - 如果不在：在 session store 中标记 `pendingToolApprovals.set(sessionId, true)`，在任务列表显示黄点
6. 用户切回该会话时，`restoreSession` 中检查 pending approvals 并回显审批弹窗
7. 用户审批/拒绝后，结果通过原有 `bash-approval-response` IPC → main process → 返回给 `handleToolExecute` → 通过 WS 发回服务端

### 8.3 审批回显流程

用户切换到有 pending approval 的会话时：

```typescript
// useChat.ts — restoreSession 中
fetchMessages()
fetchTodos()

// 回显待审批内容（审批弹窗已通过全局 listener 接收，只需确保 UI 展示）
// pendingBashApprovals 是全局的，切换到该会话后弹窗自然可见
```

Bash 审批监听需改为全局单例（在 App 初始化时注册一次），不再绑定特定 session。审批数据按 sessionId 分组存储：

```typescript
// 全局审批状态
const pendingBashApprovalsBySession = ref<Map<string, BashApprovalItem[]>>(new Map())
```

当收到 `bash-approval-request` 时，根据 requestId 关联的 sessionId 存入对应分组。当前会话的审批直接弹窗，非当前会话的标记黄点。

## 9. 删除清单

| 文件 | 操作 |
|------|------|
| `backend/.../local/LocalToolWebSocketHandler.java` | 删除 |
| `desktop/electron/main.cjs` 中 WS 连接管理代码 | 删除（wsClient, connectWebSocket, ws-connect/disconnect IPC） |
| `desktop/electron/preload.cjs` 中 WS 连接 API | 删除（connectLocalSession, disconnectLocalSession, onWsConnectionChange） |
| `desktop/src/composables/useChat.ts` 中 WS 连接逻辑 | 删除（connectLocalWebSocket, explicitDisconnect, wsConnected） |
| 后端 WebSocket 配置中 `/ws/local-tool` 端点 | 删除 |

## 10. 改动清单

| 文件 | 改动 |
|------|------|
| `LocalToolSessionRegistry.java` | 重写：去掉 WebSocketSession 依赖，改为 sessionId→userId 映射，通过 StreamingWsRegistry 发消息 |
| `StreamingWsHandler.java` | 新增 tool_result/tool_error 消息处理；handleSendMessage 中注册 LOCAL 会话的 userId；afterConnectionClosed 中 failAllPending |
| `main.cjs` | 新增 tool-execute IPC handler；保留工具执行函数和 Bash 审批逻辑 |
| `preload.cjs` | 新增 toolExecute API；删除 WS 连接 API |
| `useStreamWS.ts` | routeEvent 新增 tool_execute 处理；新增 handleLocalToolExecute；全局注册 Bash 审批监听 |
| `useChat.ts` | 删除所有 WS 连接逻辑；restoreSession 简化 |
| `session store` | 新增 pendingToolApprovals 状态 |
| `TaskIndexPanel.vue` | 任务标题后增加黄色圆点指示器 |
| `StreamingWsRegistry.java` | 无改动 |

## 11. 迁移步骤

1. **后端**：改造 LocalToolSessionRegistry，去掉 WebSocketSession 依赖
2. **后端**：StreamingWsHandler 新增 tool_result/tool_error 处理 + LOCAL 会话 userId 注册
3. **后端**：删除 LocalToolWebSocketHandler，移除 /ws/local-tool 端点
4. **Electron**：main.cjs 新增 tool-execute IPC，删除 WS 连接管理代码
5. **Electron**：preload.cjs 更新 API 桥接
6. **渲染进程**：useStreamWS 新增 tool_execute 路由和执行逻辑
7. **渲染进程**：useChat 删除 WS 连接逻辑，简化 restoreSession
8. **渲染进程**：session store + TaskIndexPanel 增加待审批指示器
9. **测试**：验证 LOCAL 模式会话的工具执行、Bash 审批、切换会话无感、非活跃会话工具调用正常

## 12. 风险与注意事项

- **Bash 审批无超时**：后端 CompletableFuture 不设超时（用户要求），但需确保客户端断连时 failAllPending 正确触发，避免 future 永久悬挂
- **消息路由正确性**：tool_execute 消息中的 sessionId 必须准确，渲染进程必须按 sessionId 路由而非当前活跃会话
- **并发工具调用**：多个 session 可能同时发起工具调用，审批队列需按 sessionId 隔离
