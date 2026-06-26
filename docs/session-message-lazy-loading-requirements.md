# 会话消息按轮懒加载需求文档

## 背景

当前客户端进入已有会话时，会调用 `GET /api/v1/sessions/{id}/messages` 一次性加载该会话的全部消息。后端实现按 `session_id` 查询并按 `created_at` 升序返回所有 `message` 记录，同时附带 `thinkingContent`、`toolCalls`、`fileChanges` 等字段。

当会话轮数较多、工具调用较多或模型推理内容较长时，首屏加载会出现以下问题：

- 响应体随会话历史线性增长，网络传输变慢。
- 前端需要一次性解析和渲染大量消息，进入会话变慢。
- `MEDIUMTEXT` 类型字段可能导致单条消息体积较大，放大全量加载成本。
- 用户通常优先查看最近上下文，历史消息不必首屏全部加载。

## 目标

将会话消息加载改为按“对话轮次”懒加载：

- 默认进入会话时，只加载最近 5 轮对话。
- 一条 `USER` 消息代表一轮对话的开始。
- 用户向上滚动到历史顶部附近时，如果还有更多历史消息，则自动继续加载更早的 5 轮。
- 前端展示顺序仍保持从旧到新。
- 对正在进行中的会话，实时新增消息仍通过现有 WebSocket 流式机制追加，不受历史懒加载影响。

## 术语定义

### 对话轮次

一轮对话从一条 `USER` 消息开始，到下一条 `USER` 消息之前结束。

示例：

```text
USER A
ASSISTANT A1
TOOL A2
ASSISTANT A3
USER B
ASSISTANT B1
```

以上包含 2 轮：

- 第 1 轮：`USER A` 到 `ASSISTANT A3`
- 第 2 轮：`USER B` 到 `ASSISTANT B1`

### 最近 5 轮

按消息时间排序后，取最后 5 条 `USER` 消息作为轮次起点，并返回这些起点及其之后的所有相关消息。

如果会话总轮次不足 5 轮，则返回全部消息。

## 用户体验需求

### 首次进入会话

- 客户端请求最近 5 轮消息。
- 消息区初始展示最近历史，加载完成后滚动到底部。
- 如果仍有更早历史，消息区顶部显示轻量加载状态或由滚动触发自动加载。
- 如果没有更早历史，不显示“加载更多”状态。

### 向上加载历史

- 用户向上滚动到消息容器顶部附近时，自动请求更早 5 轮。
- 新加载的历史消息追加到当前消息列表前面。
- 追加历史后保持用户当前阅读位置，不应突然跳到顶部或底部。
- 加载期间避免重复请求。
- 接口返回无更多历史后，后续滚动不再请求。

### 发送新消息或接收流式消息

- 用户发送新消息时，按现有逻辑追加到当前消息列表末尾。
- 新会话或当前会话流式回复不需要触发历史加载。
- 如果用户正在查看历史，是否自动滚到底部沿用现有聊天面板行为；本需求不额外改变该策略。

## 接口需求

### 推荐接口形态

复用现有接口，增加查询参数：

```http
GET /api/v1/sessions/{id}/messages?roundLimit=5&beforeMessageId={messageId}
```

参数说明：

- `roundLimit`：本次加载的轮次数，默认 `5`。
- `beforeMessageId`：游标，可选。表示只加载该消息之前的更早历史。
  - 首次加载不传，返回最近 `roundLimit` 轮。
  - 加载更早历史时，传当前前端已加载消息中的最小 `message.id`。

### 推荐响应结构

当前接口直接返回数组，不足以表达是否还有更多历史。建议改为分页响应结构：

```json
{
  "messages": [],
  "hasMore": true,
  "nextBeforeMessageId": 123
}
```

字段说明：

- `messages`：本次返回的消息，按 `created_at ASC, id ASC` 排序。
- `hasMore`：是否还有更早历史。
- `nextBeforeMessageId`：本次结果中的最小消息 ID；下一次加载更早历史时作为 `beforeMessageId`。

### 兼容性说明

项目当前处于初版开发阶段，无需强制兼容旧响应结构。可以直接将客户端和服务端同时改为新结构。

如果希望降低改动风险，也可以临时增加新接口：

```http
GET /api/v1/sessions/{id}/messages/page
```

但推荐直接演进现有接口，避免长期保留两个行为相近的接口。

## 后端实现要点

### 查询策略

后端需要按“轮”分页，而不是按消息条数分页。

推荐实现步骤：

1. 确定游标边界。
   - 首次加载：边界为当前会话最后一条消息之后。
   - 加载历史：边界为 `beforeMessageId` 对应消息之前。
2. 在边界之前倒序查询 `role = 'USER'` 的轮次起点，取 `roundLimit + 1` 条。
   - 多查 1 条用于判断 `hasMore`。
3. 如果查到的用户消息数量大于 `roundLimit`，说明还有更多历史。
4. 使用本页最早一轮的 `USER` 消息作为起点，查询从该起点到边界之前的所有消息。
5. 最终按 `created_at ASC, id ASC` 返回。

### 边界规则

- `beforeMessageId` 不存在或不属于当前会话时，应返回业务错误或空结果；建议返回业务错误，便于发现客户端状态问题。
- 同一秒内可能存在多条消息，排序必须使用 `created_at ASC, id ASC`，避免顺序不稳定。
- 查询 file changes 时，只查询本页消息关联的变更，避免继续按整个 session 全量查询。
- 首次加载正在运行的会话时，如果最后一轮还未完成，也应作为最近轮次返回。

### 数据库索引建议

当前 `message` 表已有 `session_id` 和 `created_at` 单列索引。按轮分页会频繁使用以下条件：

- `session_id`
- `role = 'USER'`
- `id < beforeMessageId` 或时间边界
- 排序

建议评估增加组合索引：

```sql
(session_id, role, id)
(session_id, id)
```

如果最终以 `created_at + id` 作为游标，则应考虑：

```sql
(session_id, role, created_at, id)
(session_id, created_at, id)
```

由于 `id` 为自增主键且消息按插入顺序生成，优先使用 `id` 游标实现更简单。

## 前端实现要点

### 状态管理

每个 session 需要维护历史分页状态：

- `messagesLoaded`：当前是否已加载过首批消息。
- `hasMoreMessages`：是否还有更早历史。
- `loadingOlderMessages`：是否正在加载更早历史。
- `nextBeforeMessageId`：下一次历史加载游标。

这些状态应按 `sessionId` 隔离，避免切换会话时串状态。

### 首次加载

`useChat.fetchMessages()` 从全量加载改为请求：

```text
roundLimit=5
```

收到数据后：

- 使用现有 `mapApiMessagesToChat` 映射消息。
- 写入当前 session 的消息缓存。
- 写入 `hasMoreMessages` 和 `nextBeforeMessageId`。
- 初始加载完成后滚动到底部。

### 向上滚动加载

`ChatPanel` 的消息容器已有 `messagesContainer`，可增加滚动监听：

- 当 `scrollTop` 小于阈值时触发加载更早历史。
- 如果 `loadingOlderMessages = true` 或 `hasMoreMessages = false`，不触发。
- 请求参数使用当前 `nextBeforeMessageId`。
- 新数据 prepend 到已有消息数组前面。
- prepend 前记录 `scrollHeight` 和 `scrollTop`，prepend 后恢复为：

```text
newScrollTop = newScrollHeight - oldScrollHeight + oldScrollTop
```

以保持阅读位置稳定。

### 轮次展示

当前 `ChatPanel` 已经基于 `USER` 消息计算 `messageRounds`，懒加载后仍可复用该逻辑。

需要注意：如果历史分页返回必须从 `USER` 起点开始，则前端不会出现“页首是半轮 assistant/tool 消息”的问题。

## 管理后台影响

管理后台 `admin/src/views/session/SessionDetailView.vue` 当前也会加载全量消息。

本需求优先目标是桌面客户端聊天加载体验。管理后台有两种选择：

1. 同步改为按轮懒加载，保持接口使用一致。
2. 暂时保留管理后台全量查看能力，但需要单独接口或参数支持。

建议优先统一接口行为，并在管理后台详情页也使用懒加载，避免长会话详情页同样变慢。

## 验收标准

- 进入包含超过 5 轮的会话时，首个消息接口只返回最近 5 轮及其关联消息。
- 进入不足 5 轮的会话时，返回全部消息且 `hasMore = false`。
- 向上滚动到顶部附近时，自动加载更早 5 轮。
- 多次向上滚动后，所有历史按正确顺序拼接，无重复消息、无缺失消息。
- 历史加载过程中不会并发触发重复请求。
- prepend 历史消息后，用户当前阅读位置保持稳定。
- 最早历史加载完成后，`hasMore = false`，继续向上滚动不再请求。
- 正在运行的会话仍能正常接收 WebSocket 流式消息。
- 消息的 `thinkingContent`、`toolCalls`、`fileChanges` 仍能正常展示。

## 风险与注意事项

- 如果后端按消息条数分页，会切断一轮对话，导致前端轮次展示异常；必须按 `USER` 起点分页。
- 如果 file changes 仍按 session 全量查询，会抵消消息分页收益；必须改为仅查询本页消息或本页 session 范围。
- 如果只用 `created_at` 排序，同一时间写入多条消息时可能顺序不稳定；需要结合 `id` 排序。
- 如果前端 prepend 后不修正滚动位置，用户体验会明显跳动。
- 如果编辑历史用户消息会截断后续消息，需要同步清理分页状态并重新加载当前会话最近 5 轮。

## 初步复杂度判断

这个逻辑整体可做，复杂度中等。前端已有按 `USER` 消息分轮的展示逻辑，主要工作集中在：

- 后端新增按轮分页查询和响应结构。
- 前端 session store 增加按会话分页状态。
- `useChat.fetchMessages` 区分首次加载和加载更早历史。
- `ChatPanel` 增加顶部滚动触发和 prepend 后滚动位置保持。

核心难点不是 UI 展示，而是后端必须保证每次返回完整轮次，且前端合并历史时不能重复、不能跳动。
