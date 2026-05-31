# SSE → WebSocket 迁移总结

> 完成日期：2026-05-30

## 1. 背景

原架构使用 SSE（Server-Sent Events）实现流式对话，每个 Session 对应一个 `SseEmitter` 连接。桌面客户端切换任务时需要断开当前 SSE 并重新建立连接，导致：

- 切换任务时流式输出中断
- 切回原任务无法恢复实时输出
- 多任务并发时连接数线性增长

改造为 WebSocket 后，单用户仅维持一条持久连接，通过 `sessionId` 多路复用所有任务的事件流。

## 2. 架构变化

```
改造前：
  桌面端 ──SSE──▶ SessionController /stream (每 Session 一条 SseEmitter)
  桌面端 ──REST──▶ SessionController /messages (发送消息)

改造后：
  桌面端 ◀──WS──▶ StreamingWsHandler /ws/stream (单连接，按 sessionId 路由)
  桌面端 ──WS──▶ { type: "send_message", sessionId, data } (发送消息)
```

## 3. 文件变更清单

### 3.1 后端新增（4 个文件）

| 文件 | 职责 |
|------|------|
| `session/ws/WsEvent.java` | WS 事件 DTO，包含 type、sessionId、data |
| `session/ws/StreamingWsRegistry.java` | 连接注册表，管理 userId↔WebSocket 映射和 sessionId 订阅关系 |
| `session/ws/WsStreamingEventListener.java` | 实现 `AgentEventListener`，将 8 种 Agent 回调转为 WS 消息推送 |
| `session/ws/StreamingWsHandler.java` | WS 主处理器，处理 subscribe/unsubscribe/send_message/cancel/ping，管理 AgentLoop 线程池执行 |

### 3.2 后端修改（2 个文件）

| 文件 | 变更 |
|------|------|
| `config/WebSocketConfig.java` | 注册 `/ws/stream` 端点，绑定 `StreamingWsHandler` |
| `session/controller/SessionController.java` | 移除 `POST /messages` 和 `GET /stream` 端点及相关 DTO，保留纯 REST CRUD |

### 3.3 后端删除（1 个文件）

| 文件 | 原因 |
|------|------|
| `session/SseEmitterRegistry.java` | SSE 连接注册表，已被 `StreamingWsRegistry` 替代 |

### 3.4 前端新增（1 个文件）

| 文件 | 职责 |
|------|------|
| `composables/useStreamWS.ts` | 全局单例 WS 管理：连接/重连（指数退避 1s→30s）/心跳（30s ping-pong）/事件路由 |

### 3.5 前端修改（3 个文件）

| 文件 | 变更 |
|------|------|
| `stores/session.ts` | 新增多 Session 消息缓存（`sessionMessages` Map）、Todo 缓存、Activity 缓存、ContextWindow 缓存、Compaction 状态；新增 `appendDelta`、`appendToolCallStart`、`updateToolCallResult` 等 action |
| `composables/useChat.ts` | 完全重写：移除 SSE 逻辑，改用 WS subscribe/sendMessage/pendingCallbacks 流程；消息/Todo 从 store computed 获取 |
| `views/task/TaskView.vue` | 移除 30s 轮询定时器（WS `session_list_update` 实时推送替代）；切换任务时仅切换订阅，不断开连接 |

### 3.6 前端删除（1 个文件）

| 文件 | 原因 |
|------|------|
| `composables/useSSE.ts` | SSE 连接管理，已被 `useStreamWS.ts` 替代 |

## 4. WS 协议

### 4.1 连接

```
ws://host/ws/stream?token={jwt}
```

JWT 解析 `sub` claim 获取 `userId`，建立连接后发送 `{ type: "connected", data: { userId } }`。

### 4.2 客户端→服务端消息

| type | 字段 | 说明 |
|------|------|------|
| `subscribe` | sessionId | 订阅某个 Session 的事件流 |
| `unsubscribe` | sessionId | 取消订阅 |
| `send_message` | sessionId, data.content, data.eventId | 发送消息触发 Agent 执行 |
| `cancel` | sessionId | 取消正在执行的 Agent |
| `ping` | — | 心跳保活 |

### 4.3 服务端→客户端消息

| type | 来源 | 说明 |
|------|------|------|
| `connected` | Handler | 连接确认 |
| `pong` | Handler | 心跳响应 |
| `content_delta` | Listener | 文本增量 |
| `tool_call_start` | Listener | 工具调用开始 |
| `tool_call_result` | Listener | 工具调用结果 |
| `activity` | Listener | 活动记录 |
| `todo_updated` | Listener | Todo 列表更新 |
| `context_window` | Listener | 上下文窗口信息 |
| `compaction_start` | Listener | 上下文压缩开始 |
| `compaction_end` | Listener | 上下文压缩结束 |
| `message_end` | Listener | 消息结束（含 token 统计） |
| `session_status` | Handler | Session 阶段变更（RUNNING/COMPLETED/FAILED） |
| `session_list_update` | Handler | 侧边栏 Session 列表实时更新 |
| `session_snapshot` | Handler | 订阅时 Session 已在运行，发送当前状态快照 |
| `error` | Handler/Listener | 错误信息 |

## 5. 关键设计决策

### 5.1 全局单例 WS

`useStreamWS.ts` 使用模块级变量（非 `ref` 组件内状态），所有页面共享同一条 WS 连接。组件卸载时不断开连接，仅切换订阅。

### 5.2 消息缓存在 Pinia Store

`sessionMessages` 以 `Map<string, ChatMessage[]>` 存储在 store 中，支持多 Session 并行缓存。切换任务时无需重新拉取（除非需要持久化历史）。

### 5.3 pendingCallbacks 机制

`useChat.sendMessage()` 通过 `pendingCallbacks` Map 等待 Agent 执行完成。WS 收到 `session_status` 非 RUNNING 时 resolve，收到 `error` 时 reject。

### 5.4 线程池隔离

Agent 执行提交到独立线程池（`ws-agent-`，core=20, max=100, queue=200），不占用 WebSocket I/O 线程。

### 5.5 取消机制

`cancel` 消息设置 `AtomicBoolean` cancel flag，`AgentLoop` 在每轮迭代中检查该 flag 并优雅终止。

## 6. 验证状态

| 检查项 | 结果 |
|--------|------|
| 后端 `mvn compile` | 通过 |
| 前端 `vue-tsc --noEmit` | 通过 |
| SSE 残留引用（源码） | 无（仅 LLM 适配器中的 OpenAI SSE 协议引用，属正常） |
| 旧文件残留 | `useSSE.ts` 和 `SseEmitterRegistry.java` 已删除 |
| 事件覆盖 | 后端 8 个 `AgentEventListener` 方法全部实现，前端 13 种事件类型全部路由 |
| Store action 完整性 | `useStreamWS.ts` 调用的所有 store action 均存在并导出 |
| 运行时测试 | 待验证 |

## 7. 待验证项

以下需在运行时环境中验证：

1. **基本对话流程**：发送消息 → Agent 执行 → 流式输出 → 完成
2. **任务切换**：运行中切换到另一个任务，再切回来，确认事件流正确
3. **多任务并发**：两个任务同时运行，确认事件互不干扰
4. **断线重连**：断开网络后恢复，确认 WS 自动重连并重新订阅
5. **取消执行**：运行中点击取消，确认 Agent 优雅终止
6. **LOCAL 模式**：桌面端本地执行模式的 WS 连接和 Bash 审批流程
