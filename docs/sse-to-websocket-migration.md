# SSE → WebSocket 多任务流式输出改造方案

> Note: The `bash` tool has been removed. `shell` is now the only command execution tool. See `shell-unification-design.md`.

> 解决桌面客户端切换任务时流式输出断连、无法并行监听多任务的问题。

## 1. 问题分析

### 当前架构

```
桌面客户端                           后端
┌─────────────┐                ┌──────────────────┐
│  TaskView    │  EventSource   │  SseEmitter      │
│  (单实例复用) │◄──────────────│  Registry        │
│             │  1:1 绑定 session │  (1 emitter/session) │
│  useChat    │                │                  │
│  (局部状态)  │                │  AgentLoop       │
│  messages[] │                │  (线程池执行)      │
└─────────────┘                └──────────────────┘
```

**三个核心问题：**

| # | 问题 | 根因 | 影响 |
|---|------|------|------|
| 1 | 切走即断流 | `loadSession()` 调用 `cleanup()` 关闭 EventSource | 无法后台监听任务进度 |
| 2 | 切回不重连 | `restoreSession()` 只拉历史消息，不重建 SSE | 回来后看不到实时输出 |
| 3 | 消息随组件销毁 | `messages` 是 composable 局部 ref，不在 Pinia store | 切任务 = 清空消息数组 |

### 不受影响的部分

- 后端 agent 执行不依赖客户端连接，断开后继续运行
- 消息最终持久化到 `message` 表，不会丢失最终结果
- 侧边栏 phase 指示器有 30s 轮询兜底（但不够实时）

---

## 2. 目标架构

```
桌面客户端                           后端
┌─────────────┐                ┌──────────────────┐
│  TaskView    │                │  StreamingWs     │
│  (渲染层)    │                │  Handler         │
│      ▲       │   WebSocket    │      ▲           │
│      │       │◄══════════════│      │           │
│  Pinia Store │   1:N 多路复用  │  AgentLoop      │
│  Map<sid,    │                │  (per-session)   │
│    msgs[]>   │                │                  │
└─────────────┘                └──────────────────┘

切任务 = 切换 activeSessionId → store 渲染对应 key 的消息
连接始终在线，不因切任务断开
```

**核心变化：**

1. **一条 WebSocket 连接**：用户登录后建立，生命周期跟随会话而非单个 task
2. **消息路由**：服务端按 sessionId 标记每条事件，客户端按 sessionId 分发到 Pinia store
3. **切任务零开销**：`loadSession()` 不再需要 `cleanup()`，只切换 `activeSessionId`

---

## 3. 协议设计

### 3.1 WebSocket 连接

```
URL:  ws(s)://{host}/ws/stream?token={jwt}

生命周期: 登录 → 建立连接 → 持续在线 → 登出/关闭标签页 → 断开
心跳: 客户端每 30s 发 {"type":"ping"}，服务端回 {"type":"pong"}
断线重连: 客户端指数退避重连（1s → 2s → 4s → ... → 30s cap）
```

### 3.2 消息格式（服务端 → 客户端）

所有事件统一封装为：

```json
{
  "type": "content_delta | tool_call_start | tool_call_result | activity | todo_updated | session_status | session_list_update | context_window | compaction_start | compaction_end | message_end | error | pong",
  "sessionId": 123,
  "data": { ... }
}
```

`data` 字段复用现有 SSE 事件的 payload，不改格式。示例：

```json
// content_delta
{ "type": "content_delta", "sessionId": 42, "data": { "delta": "Hello" } }

// tool_call_start
{ "type": "tool_call_start", "sessionId": 42, "data": { "tool_call_id": "tc_1", "tool_name": "bash", "arguments": "{\"command\":\"ls\"}" } }

// session_status
{ "type": "session_status", "sessionId": 42, "data": { "phase": "RUNNING" } }

// session_list_update（其他 session 的状态变化）
{ "type": "session_list_update", "sessionId": 99, "data": { "phase": "COMPLETED" } }

// message_end
{ "type": "message_end", "sessionId": 42, "data": { "prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150 } }
```

### 3.3 客户端 → 服务端消息

```json
// 订阅：告诉服务端"我要收这个 session 的实时事件"
// 进入任务页面时发送，不触发任何执行
{ "type": "subscribe", "sessionId": 42 }

// 取消订阅：离开任务页面时发送（可选，服务端在连接断开时自动清理）
{ "type": "unsubscribe", "sessionId": 42 }

// 发送消息并触发 agent 执行（替代 POST /messages + GET /stream 两步流程）
// 服务端收到后：保存消息 → 缓存内容 → 提交 AgentLoop → 通过 WS 流式返回事件
{ "type": "send_message", "sessionId": 42, "data": { "content": "请帮我...", "eventId": "uuid" } }

// 心跳
{ "type": "ping" }

// 取消正在执行的 agent
{ "type": "cancel", "sessionId": 42 }
```

**subscribe 与 send_message 的关系：**

- `subscribe` 是**被动监听**：只声明"我要收事件"，不触发执行。用于：打开已在运行的 session 时接收其实时输出。
- `send_message` 是**主动触发**：保存消息 + 启动 AgentLoop。隐含 subscribe 语义——不需要先 subscribe 再 send_message。
- 时序保障：`send_message` 的事件回调绑定在创建它的那次 AgentLoop 上，不会因为 subscribe 时序问题丢失事件。

**重连后的追赶机制：**

客户端重连后对 RUNNING 状态的 session 重新 subscribe，服务端发送 `session_snapshot` 事件补发当前状态：

```json
// 服务端在 subscribe 时检查 session 是否正在运行，如果是则发送一次快照
{
  "type": "session_snapshot",
  "sessionId": 42,
  "data": {
    "phase": "RUNNING",
    "currentToolCall": { "tool_call_id": "tc_3", "tool_name": "bash", "status": "running" },
    "partialContent": "已完成的部分文本输出...",
    "todos": [{ "id": "t1", "content": "分析代码", "status": "completed" }]
  }
}
```

断线期间的 `content_delta`、`tool_call_start` 等实时事件**不缓冲不补发**——客户端通过 `fetchMessages()` REST 接口拉取已持久化的完整消息历史，`session_snapshot` 只补充当前正在执行的那一轮的实时状态。

---

## 4. 后端改造

### 4.1 新增文件

| 文件 | 说明 |
|------|------|
| `session/ws/WsEvent.java` | WS 事件 DTO，包含 type、sessionId、data 字段 |
| `session/ws/StreamingWsHandler.java` | WebSocket 主处理器，替代 SSE 流式推送 |
| `session/ws/StreamingWsRegistry.java` | 连接注册表，管理 userId → WebSocket 映射 |
| `session/ws/WsStreamingEventListener.java` | 事件监听器，实现 AgentEventListener 接口，将回调转为 WS 消息 |

### 4.2 改造文件

#### `WebSocketConfig.java`

新增 `/ws/stream` 端点：

```java
@Override
public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
    registry.addHandler(localToolHandler, "/ws/local-tool")
            .setAllowedOrigins("*");
    registry.addHandler(streamingWsHandler, "/ws/stream")   // 新增
            .setAllowedOrigins("*");
}
```

#### `SecurityConfig.java`

`/ws/stream` 已被现有 `/ws/**` 规则覆盖，无需改动。

#### `SessionController.java`

**删除旧端点**：`POST /v1/sessions/{id}/messages`（line 168）和 `GET /v1/sessions/{id}/stream`（line 192）整体删除，逻辑迁入 `StreamingWsHandler`。

`SessionController` 保留其余端点（创建 session、获取消息列表、删除 session 等 REST API）。

当前流程：
```
POST /messages → 保存消息 → 缓存内容 → 返回 {eventId}
GET  /stream   → 创建 SseEmitter → 提交 AgentLoop 到线程池
```

新流程：**agent 执行触发统一走 WS**，`send_message` 替代 POST /messages + GET /stream 两步：

```
客户端 WS send_message
  → StreamingWsHandler.onTextMessage()
  → 校验 session 存在且有权限
  → 如果 executionMode=LOCAL，校验 LocalToolSessionRegistry 有对应连接
  → 保存用户消息到 DB
  → 缓存内容到 Caffeine
  → 创建 WsStreamingEventListener（绑定 userId + sessionId + registry）
  → 提交 AgentLoop 到线程池
  → AgentLoop 事件回调 → WsStreamingEventListener → WS 推送给客户端
```

旧的 `POST /v1/sessions/{id}/messages` 和 `GET /v1/sessions/{id}/stream` 端点**删除**，不再保留。

**AgentLoop 生命周期（与当前 SSE 路径完全一致）：**

```
send_message 到达
  → agentExecutor.submit(() -> {
      sessionService.updatePhase(sessionId, "RUNNING")
      wsRegistry.send(userId, session_status(RUNNING))
      AgentLoop loop = new AgentLoop(sessionId, content, listener, ...)
      loop.execute()  // 阻塞直到 LLM 不再调用工具
      sessionService.updatePhase(sessionId, "COMPLETED")
      wsRegistry.send(userId, session_status(COMPLETED))
      wsRegistry.send(userId, message_end(...))
    })
```

线程池配置沿用当前 `agentExecutor`（core=8, max=16, queue=200）。同一 session 不会并发执行——`send_message` 处理时检查 session phase，RUNNING 状态拒绝新请求（同当前逻辑）。

#### `SseEmitterRegistry.java` — 删除

SSE 路径整体移除，`StreamingWsRegistry` 完全替代。

#### `AgentEventListener` 实现

新增 `WsStreamingEventListener`，将每个事件回调转为 WS 消息发送：

```java
public class WsStreamingEventListener implements AgentEventListener {
    private final StreamingWsRegistry registry;
    private final Long sessionId;
    private final Long userId;

    @Override
    public void onContentDelta(String delta) {
        registry.send(userId, new WsEvent("content_delta", sessionId, Map.of("delta", delta)));
    }

    @Override
    public void onToolCallStart(String toolCallId, String toolName, String arguments) {
        registry.send(userId, new WsEvent("tool_call_start", sessionId,
            Map.of("tool_call_id", toolCallId, "tool_name", toolName, "arguments", arguments)));
    }

    // ... 其他事件同理
}
```

#### `SessionController` 广播改造

当前 `broadcastPhaseChange()` 只推给单个 session 的 SSE emitter。

**广播范围定义：** `session_list_update` 应推送给**该用户的所有已连接客户端**（多设备场景），而非所有在线用户。理由：
- session 列表是按用户隔离的，A 用户看不到 B 用户的 session
- 侧边栏只显示当前用户的 session，所以只有 session 创建者关心状态变化
- 实现：`StreamingWsRegistry.send(userId, event)` 只发给指定用户的连接集合

```java
// 在 AgentLoop 生命周期的关键节点广播：
// session phase 变更时（RUNNING/COMPLETED/FAILED）
registry.send(userId, new WsEvent("session_list_update", sessionId, Map.of("phase", "RUNNING")));
```

如果未来支持**共享 session**（多人协作），再改为按 session 成员列表广播。当前无此需求。

### 4.3 连接管理

```
StreamingWsRegistry
├── ConcurrentHashMap<Long, Set<WebSocketSession>>  // userId → 连接集合
├── ConcurrentHashMap<WebSocketSession, Long>       // 连接 → userId（反查）
├── ConcurrentHashMap<Long, Set<Long>>              // userId → 订阅的 sessionId 集合
│
├── register(session, userId)        // 连接建立时
├── unregister(session)              // 连接断开时
├── subscribe(userId, sessionId)     // 客户端发送 subscribe 时
├── unsubscribe(userId, sessionId)   // 客户端发送 unsubscribe 时
├── send(userId, event)              // 发送给指定用户的所有连接
└── broadcast(sessionId, event)      // 广播给订阅了该 session 的所有用户
```

### 4.4 并发安全

- AgentLoop 线程池与 WS 发送线程分离：AgentLoop 回调 → 事件入队 → WS 异步发送
- WS 发送使用 `WebSocketSession.sendMessage()`（异步，非阻塞 AgentLoop）
- 用户多设备登录：同一 userId 可能有多个 WS 连接，`send()` 遍历发送

---

## 5. 前端改造

### 5.1 新增文件

| 文件 | 说明 |
|------|------|
| `composables/useStreamWS.ts` | WebSocket 连接管理，替代 useSSE.ts |

### 5.2 改造文件

#### `stores/session.ts` — 新增消息缓存

```typescript
// 新增状态
const sessionMessages = ref<Map<string, ChatMessage[]>>(new Map())
const sessionTodos = ref<Map<string, TodoItem[]>>(new Map())

// 新增 actions
function appendDelta(sessionId: string, delta: string) { ... }
function addToolCallStart(sessionId: string, event: ToolCallStartEvent) { ... }
function addToolCallResult(sessionId: string, event: ToolCallResultEvent) { ... }
function setMessages(sessionId: string, messages: ChatMessage[]) { ... }
function updateTodos(sessionId: string, todos: TodoItem[]) { ... }

// 新增 getter
const activeMessages = computed(() =>
  sessionMessages.value.get(activeSessionId.value ?? '') ?? []
)
```

#### `composables/useStreamWS.ts` — 全局 WebSocket 管理

```typescript
// 在 TaskView 或 App 级别初始化一次，全局共享
export function useStreamWS() {
  const ws = ref<WebSocket | null>(null)
  const connected = ref(false)
  const reconnectDelay = ref(1000)

  function connect() {
    const token = authStore.token
    const wsUrl = apiBase.replace(/^http/, 'ws').replace(/\/api$/, '') + `/ws/stream?token=${token}`
    ws.value = new WebSocket(wsUrl)

    ws.value.onopen = () => {
      connected.value = true
      reconnectDelay.value = 1000
      // 重新订阅当前活跃 session
      subscribe(sessionStore.activeSessionId)
    }

    ws.value.onmessage = (event) => {
      const msg = JSON.parse(event.data)
      routeEvent(msg)  // 按 type + sessionId 分发到 store
    }

    ws.value.onclose = () => {
      connected.value = false
      setTimeout(connect, reconnectDelay.value)
      reconnectDelay.value = Math.min(reconnectDelay.value * 2, 30000)
    }
  }

  function routeEvent(msg: WsEvent) {
    const { type, sessionId, data } = msg

    switch (type) {
      case 'content_delta':
        sessionStore.appendDelta(sessionId, data.delta)
        break
      case 'tool_call_start':
        sessionStore.addToolCallStart(sessionId, data)
        break
      case 'tool_call_result':
        sessionStore.addToolCallResult(sessionId, data)
        break
      case 'session_status':
        sessionStore.updateSessionPhase(sessionId, data.phase)
        break
      case 'session_list_update':
        sessionStore.updateSessionPhase(sessionId, data.phase)
        break
      case 'message_end':
        sessionStore.markMessageComplete(sessionId, data)
        break
      // ... 其他事件
    }
  }

  function subscribe(sessionId: string | null) {
    if (sessionId && ws.value?.readyState === WebSocket.OPEN) {
      ws.value.send(JSON.stringify({ type: 'subscribe', sessionId }))
    }
  }

  function sendMessage(sessionId: string, content: string, eventId: string) {
    ws.value?.send(JSON.stringify({
      type: 'send_message', sessionId, data: { content, eventId }
    }))
  }

  return { connected, connect, subscribe, sendMessage, cancel }
}
```

#### `composables/useChat.ts` — 简化

改造后 `useChat` 不再持有 `messages`、`sse` 等局部状态，变为薄封装层：

```typescript
export function useChat() {
  const { sendMessage: wsSend, subscribe, cancel } = useStreamWS()
  const sessionStore = useSessionStore()

  // 消息直接从 store 读
  const messages = computed(() => sessionStore.activeMessages)
  const todos = computed(() => sessionStore.activeTodos)

  async function sendMessage(content: string) {
    // 1. 乐观更新：立即在 store 中添加用户消息
    sessionStore.addUserMessage(sessionStore.activeSessionId, content)

    // 2. 如果是新 session，先创建
    if (!sessionStore.activeSessionId) {
      await createSession()
    }

    // 3. 通过 WS 发送
    const eventId = crypto.randomUUID()
    wsSend(sessionStore.activeSessionId, content, eventId)
  }

  // loadSession 只需加载历史 + 订阅，不再 cleanup
  async function loadSession(sid: string) {
    sessionStore.setActiveSession(sid)
    subscribe(sid)  // 告诉服务端我要收这个 session 的事件
    await fetchMessages(sid)  // 拉历史消息到 store
  }

  // 不再需要 cleanup()，WS 连接是全局的

  return { messages, todos, sendMessage, loadSession, cancel }
}
```

#### `views/task/TaskView.vue` — 简化

```typescript
// 删除：
// - useSSE.ts 导入和所有相关调用
// - cleanup() 中的 sse.stop()、SSE 相关逻辑
// - messages.value = [] 等手动状态重置（消息从 store 读）
// - 30s 轮询 fetchSessions（session_list_update 已通过 WS 实时推送）

// 改造 watch：
watch(sessionIdParam, (newSid, oldSid) => {
  if (newSid && newSid !== oldSid) {
    loadSession(newSid)  // 只切换订阅 + 拉历史，不断开连接
  }
})

// 模板不变，messages 从 store 的 computed 读取
```

#### `electron/main.cjs` — 本地工具 WS 保留不变

`/ws/local-tool` 连接保持现状，它负责工具执行桥接，与流式输出无关。

---

## 6. 改造步骤

一次性完成，不分阶段。

```
后端：
1. 新建 StreamingWsHandler + StreamingWsRegistry + WsStreamingEventListener
2. WebSocketConfig 注册 /ws/stream 端点
3. StreamingWsHandler 实现消息路由：
   - subscribe → 注册到 registry 的订阅集合
   - send_message → 校验权限 + LOCAL 连接 → 保存消息 → 提交 AgentLoop
   - cancel → 取消对应 session 的 AgentLoop
   - ping → 回 pong
4. WsStreamingEventListener 接入 AgentLoop，事件通过 registry 推送给 userId
5. session_list_update 广播：phase 变更时推送给 session 创建者的所有连接
6. 删除 SessionController 中的 POST /messages + GET /stream 端点
7. 删除 SseEmitterRegistry.java

前端：
8. 新建 useStreamWS.ts，实现全局 WS 连接管理
9. stores/session.ts 新增 sessionMessages Map 和相关 actions
10. 改造 useChat.ts：messages 从 store computed 读取，sendMessage 走 WS
11. 改造 TaskView.vue：loadSession 只切订阅，删除 SSE/cleanup 逻辑和 30s 轮询
12. 删除 useSSE.ts

验证：
13. 多任务并行执行 + 切换 + 返回，确认流式输出不中断
14. 断线重连：断网 → 恢复 → session_snapshot 补发 → 消息不丢失
15. 50+ 并发 session 的 WS 广播性能
```

---

## 7. 边界场景处理

### 7.1 断线重连

```
客户端断线
  → 自动重连（指数退避 1s → 30s）
  → 重连成功后重新 subscribe 所有正在查看的 session
  → 服务端检查 session 状态：
      IDLE/COMPLETED/FAILED → 无需补偿，历史消息通过 REST 拉取
      RUNNING → 发送 session_snapshot 补发当前执行状态，之后继续实时推送
```

**断线期间丢失的事件类型：**

| 事件类型 | 是否持久化 | 断线后能否恢复 | 说明 |
|---------|-----------|--------------|------|
| `content_delta` | 否 | 不可恢复 | 实时打字效果，最终完整文本通过 ASSISTANT 消息持久化 |
| `tool_call_start` | 否 | 不可恢复 | 工具开始执行的通知，最终 TOOL 消息持久化了结果 |
| `tool_call_result` | 部分 | 通过 REST 恢复 | result 内容持久化为 TOOL 消息，但 summary/status 字段丢失 |
| `activity` | 否 | 不可恢复 | 中间活动通知，无持久化 |
| `todo_updated` | 否 | 通过 session_snapshot 恢复 | 快照中包含最新 todos 状态 |
| `context_window` | 否 | 不可恢复 | 信息性事件，不影响功能 |
| `compaction_start/end` | 否 | 不可恢复 | 信息性事件，不影响功能 |
| `session_status` | 是 | 通过 REST 恢复 | phase 持久化在 session 表 |
| `message_end` | 是 | 通过 REST 恢复 | 完整消息持久化在 message 表 |

**结论：服务端不需要缓冲事件**，因为：
1. 最终结果（USER/ASSISTANT/TOOL 消息）已持久化，`fetchMessages()` 可完整恢复
2. 实时事件（delta、activity）是"打字效果"，丢失不影响最终内容
3. 中间状态（todos、当前工具调用）通过 `session_snapshot` 在重连时补发

### 7.2 多设备登录

同一用户可能在多台设备登录。`StreamingWsRegistry` 按 userId 管理连接集合，事件广播到该用户的所有连接。

### 7.3 浏览器标签页（非 Electron）

桌面端用 Electron 走原生 WS。如果未来有 Web 版，浏览器端也直接用 `new WebSocket()`，逻辑完全一致。不需要 SockJS/STOMP。

---

## 8. 风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| WS 连接被 Nginx/网关超时断开 | 中 | 流式中断 | 心跳 30s + 客户端自动重连 |
| 大量并发 session 导致 WS 消息风暴 | 低 | 前端渲染卡顿 | 只推送 subscribe 的 session 事件，非全量广播 |
| AgentLoop 事件回调阻塞在 WS 发送 | 低 | agent 执行变慢 | WS 发送异步化，不阻塞回调线程 |
| 浏览器 WS 连接数限制（同域） | 极低 | 连接失败 | 一条连接多路复用，不受 6 连接限制影响 |

---

## 9. 文件变更清单

### 新增

```
backend/src/main/java/cn/etarch/mao/session/ws/
  ├── StreamingWsHandler.java
  ├── StreamingWsRegistry.java
  └── WsStreamingEventListener.java

desktop/src/composables/
  └── useStreamWS.ts
```

### 改造

```
backend/
  ├── config/WebSocketConfig.java          — 注册 /ws/stream 端点
  └── session/service/SessionService.java  — 广播 phase 变更到 WS

desktop/
  ├── stores/session.ts                    — 新增 sessionMessages Map
  ├── composables/useChat.ts              — 简化，消息从 store 读，sendMessage 走 WS
  └── views/task/TaskView.vue             — 删除 SSE 逻辑，loadSession 只切订阅
```

### 删除

```
backend/
  ├── session/SseEmitterRegistry.java          — SSE 注册表，整体移除
  └── session/controller/SessionController.java — 删除 POST /messages + GET /stream 端点

desktop/
  └── composables/useSSE.ts                    — SSE 客户端，整体移除
```

---

## 10. 附：SSE vs WebSocket 对比

| 维度 | 当前 SSE | 改造后 WebSocket |
|------|---------|-----------------|
| 连接数 | 每 session 1 条 | 全局 1 条 |
| 切任务 | 断开旧连接 + 建新连接 | 只切换渲染目标 |
| 后台监听 | 不支持 | 支持（subscribe 机制） |
| 双向通信 | 不支持 | 支持（可发送消息、取消） |
| 浏览器兼容性 | 好 | 好（IE 不支持但已不需考虑） |
| 代理/网关穿透 | 好 | 需确认 Nginx proxy_read_timeout（默认 60s，心跳 30s 可覆盖） |
| 实现复杂度 | 低 | 中 |
| 多任务体验 | 差（断流） | 好（无缝切换） |
