# AI 对话页面「实时上下文大小」实现方案

## 概述

AI 对话页面通过 WebSocket 实时推送和运行时快照两种机制，将后端计算的上下文 Token 数量展示在前端界面上。前端使用紧凑格式（如 `12.3k`）展示，用户可直观感知当前对话的上下文消耗情况。

## 架构总览

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Frontend (Vue)                             │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  AiChatHome.vue                                               │  │
│  │  ┌─────────────────────────────────────────────────────────┐  │  │
│  │  │  <el-tag>上下文 {{ formatTokenCompact(lastContextTokens) }} │  │
│  │  └─────────────────────────────────────────────────────────┘  │  │
│  │  syncSessionLastContextTokens() ──┐                           │  │
│  └───────────────────────────────────┼───────────────────────────┘  │
│                                      │                              │
│  ┌───────────────────────────────────▼───────────────────────────┐  │
│  │  WebSocket Handler (handleIncoming)                           │  │
│  │  ├── cmd: "ctxWindow"  ──► extract inputTokens               │  │
│  │  └── cmd: "bindResponse" ──► runtimeSnapshot.inputTokens     │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              │ WebSocket
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Backend (Java)                               │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  LlmTokenEstimator                                            │  │
│  │  ├── cl100k_base encoder (jtokkit)                            │  │
│  │  └── estimateMessages() ──► total tokens                      │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                              │                                      │
│  ┌───────────────────────────▼───────────────────────────────────┐  │
│  │  AbstractAgent                                                │  │
│  │  ├── emitCtxWindow() ──► SseEvent.CTX_WINDOW                 │  │
│  │  └── context.addMetadata("lastLlmInputTokens", tokens)       │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                              │                                      │
│  ┌───────────────────────────▼───────────────────────────────────┐  │
│  │  SessionCompactionManager (触发点)                            │  │
│  │  ├── compactIfNeeded() ──► 压缩前上报                        │  │
│  │  └── compactLoopIfNeeded() ──► 工具循环压缩前后上报           │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                              │                                      │
│  ┌───────────────────────────▼───────────────────────────────────┐  │
│  │  ConversationRuntimeManager                                   │  │
│  │  ├── buildRuntimeSnapshot() ──► snapshot.inputTokens          │  │
│  │  └── Redis: etetet:agentic:runtime:{conversationId}          │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## 一、前端实现

### 1.1 界面展示

**文件**: `acg-dama-web/src/views/home/components/AiChatHome.vue`

```vue
<!-- 第 13-15 行 -->
<el-tag effect="plain" class="agent-chat-context-tag">
  <span>上下文 {{ formatTokenCompact(activeSession?.lastContextTokens) }}</span>
</el-tag>
```

`lastContextTokens` 是 `AiChatSession` 对象的属性，类型为 `number | undefined`。

### 1.2 Token 数量格式化

**文件**: `AiChatHome.vue` 第 851-863 行

```typescript
function formatTokenCompact(value?: number | null) {
  const tokenCount = Number(value);
  if (!Number.isFinite(tokenCount) || tokenCount <= 0) {
    return '--';
  }
  if (tokenCount < 1000) {
    return `${Math.round(tokenCount)}`;
  }
  if (tokenCount < 10000) {
    return `${(tokenCount / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  }
  return `${Math.round(tokenCount / 1000)}k`;
}
```

格式化规则：
| Token 范围 | 显示格式 | 示例 |
|-----------|---------|------|
| ≤ 0 或无效 | `--` | `--` |
| 1 - 999 | 原始数字 | `512` |
| 1,000 - 9,999 | `x.xk` | `3.2k` |
| ≥ 10,000 | `xk` (四舍五入) | `12k` |

### 1.3 Token 更新的三条路径

前端通过以下三条路径更新 `lastContextTokens`：

#### 路径 A：`ctxWindow` WebSocket 事件（实时）

```typescript
// handleIncoming 函数，第 1950-1954 行
if (payload.cmd === 'ctxWindow') {
  const tokenPayload = parseJsonMaybe<{ inputTokens?: number }>(body, {});
  syncSessionLastContextTokens(activeSession.value?.id, tokenPayload.inputTokens);
  return;
}
```

**触发时机**: 后端在会话压缩前、工具循环压缩前后主动推送。

#### 路径 B：`bindResponse` 中的 runtimeSnapshot

```typescript
// handleIncoming 函数，第 1866-1876 行
if (payload.cmd === 'bindResponse') {
  const bindPayload = parseJsonMaybe<{ conversationId?: string; runtimeSnapshot?: RuntimeSnapshot | null }>(body, {});
  hydrateRuntimeSnapshot(bindPayload.runtimeSnapshot);
  // ...
}
```

`hydrateRuntimeSnapshot` 内部调用：

```typescript
// 第 1558 行
syncSessionLastContextTokens(activeSession.value?.id, snapshot.inputTokens);
```

**触发时机**: 前端绑定会话（`bind`）时，后端返回当前运行时快照。

#### 路径 C：`RuntimeSnapshot` 中的 `inputTokens`

```typescript
// hydrateRuntimeSnapshot 函数，第 1527-1560 行
function hydrateRuntimeSnapshot(snapshot?: RuntimeSnapshot | null) {
  // ...
  syncSessionLastContextTokens(activeSession.value?.id, snapshot.inputTokens);
  // ...
}
```

### 1.4 Token 同步函数

```typescript
// 第 911-924 行
function syncSessionLastContextTokens(
  aiSessionId: number | undefined,
  tokens?: number | null
) {
  if (!aiSessionId) return;
  const nextTokens = Number(tokens);
  const normalizedTokens = Number.isFinite(nextTokens) && nextTokens > 0
    ? nextTokens
    : undefined;

  // 更新会话列表中的对应会话
  const matched = sessions.value.find((item) => item.id === aiSessionId);
  if (matched) {
    matched.lastContextTokens = normalizedTokens;
  }

  // 更新当前活跃会话
  if (activeSession.value?.id === aiSessionId) {
    activeSession.value.lastContextTokens = normalizedTokens;
  }
}
```

### 1.5 前端数据模型

```typescript
interface AiChatSession {
  id: number;
  conversationId: string;
  title?: string;
  lastContextTokens?: number;  // ← 上下文 Token 数
  // ... 其他字段
}

interface RuntimeSnapshot {
  conversationId?: string;
  inputTokens?: number;  // ← 运行时 Token 数
  // ... 其他字段
}
```

## 二、后端实现

### 2.1 Token 估算核心

**文件**: `etetet-biz/.../support/LlmTokenEstimator.java`

使用 **jtokkit** 库的 `cl100k_base` 编码器（与 OpenAI GPT-3.5/GPT-4 系列模型使用相同的 tokenizer）精确计算 Token 数。

```java
public int estimatePromptInputTokens(AgentContext context) {
    return estimateMessages(context.getAnswerMessages());
}

public int estimateMessages(List<Message> messages) {
    int total = 0;
    for (Message message : messages) {
        total += estimateMessage(message);
    }
    return total;
}

private int estimateMessage(Message message) {
    String text = toMessageText(message);
    return estimateTokens(text);
}

private int estimateTokens(String text) {
    try {
        // 使用 cl100k_base 编码器精确计算
        return encoder.countTokens(text).orElse(text.length() / 4);
    } catch (Exception e) {
        // 降级：粗略估算
        return text.length() / 4;
    }
}
```

### 2.2 消息类型转换

`toMessageText` 将不同类型的 Spring AI Message 转为文本后计算：

| 消息类型 | 转换格式 |
|---------|---------|
| `UserMessage` | `"用户: {text}"` |
| `SystemMessage` | `"系统: {text}"` |
| `AssistantMessage` | `"助手: {text}"` + 工具调用信息 |
| `ToolResponseMessage` | `"工具结果[name]: {data}"` |

### 2.3 ctxWindow 事件发送

**文件**: `etetet-biz/.../agent/AbstractAgent.java`

```java
// 重载 1: 自行计算
public C emitCtxWindow(C context, String model) {
    int inputTokens = llmTokenEstimator.estimatePromptInputTokens(context);
    this.emitCtxWindow(context, inputTokens);
    return context;
}

// 重载 2: 接收外部传入的值
public void emitCtxWindow(AgentContext context, int inputTokens) {
    // 存入 context metadata，供后续 runtimeSnapshot 读取
    context.addMetadata(LAST_LLM_INPUT_TOKENS_KEY, inputTokens);

    // 构造 WebSocket 消息
    Map<String, Object> payload = new HashMap<>();
    payload.put("inputTokens", inputTokens);
    payload.put("conversationId", context.getSession().getConversationId());
    this.emit(context, SseEvent.CTX_WINDOW, Jackson.toJson(payload));
}
```

WebSocket 消息结构：
```json
{
  "module": "ws",
  "cmd": "ctxWindow",
  "body": "{\"inputTokens\":12345,\"conversationId\":\"conv-xxx\"}"
}
```

### 2.4 ctxWindow 触发时机

**文件**: `etetet-biz/.../manager/SessionCompactionManager.java`

#### 场景 A：会话级压缩前

```java
// compactIfNeeded() 方法
private void emitSessionCtxWindow(...) {
    int totalTokens = estimatePromptInputTokens(
        agent, systemMessage, summary, histories, query
    );
    agent.emitCtxWindow(context, totalTokens);
}
```

#### 场景 B：工具循环压缩前后

```java
// compactLoopIfNeeded() 方法
// 压缩前
agent.emitCtxWindow(context, llmTokenEstimator.estimateMessages(conversationHistory));
// ... 执行压缩 ...
// 压缩后
agent.emitCtxWindow(context, llmTokenEstimator.estimateMessages(rebuilt));
```

### 2.5 压缩触发阈值配置

| 配置项 | 默认值 | 说明 |
|-------|-------|------|
| `contextWindowTokens` | 96000 | 上下文窗口大小 |
| `triggerRatio` | 0.72 | 触发压缩的 Token 占比阈值 |
| `minNewMessageCount` | 8 | 新消息数最小触发条件 |
| `minNewTokenCount` | 20000 | 新增 Token 最小触发条件 |
| `loopTriggerToolRounds` | 5 | 工具调用轮次触发阈值 |
| `loopTriggerTokens` | 96000 | 工作记忆 Token 触发阈值 |

触发条件：当新增消息 Token ≥ `minNewTokenCount`，或消息数 ≥ `minNewMessageCount` 且总 Token ≥ `contextWindowTokens × triggerRatio` 时触发。

### 2.6 RuntimeSnapshot 中的 inputTokens

**文件**: `etetet-biz/.../agent/runtime/ConversationRuntimeManager.java`

```java
// 构建运行时快照
snapshot.setInputTokens(resolveInputTokens(context));

// 从 context metadata 中读取
private Integer resolveInputTokens(AgentContext context) {
    Object tokenValue = context.getMetadata().get(LAST_LLM_INPUT_TOKENS_KEY);
    if (tokenValue instanceof Number number) {
        return Math.max(0, number.intValue());
    }
    return null;
}
```

数据流：`emitCtxWindow()` → `context.addMetadata("lastLlmInputTokens", tokens)` → `resolveInputTokens()` → `snapshot.setInputTokens()`

### 2.7 bind 操作返回快照

**文件**: `etetet-web/.../action/WsAction.java`

```java
public void bind(WsMessage message) {
    ConversationRuntimeSnapshot runtimeSnapshot = conversationRuntimeManager
        .getSharedRuntimeSnapshot(aiSession.getConversationId());
    Map<String, Object> response = new HashMap<>();
    response.put("conversationId", aiSession.getConversationId());
    response.put("runtimeSnapshot", runtimeSnapshot);
    message.reply("bindResponse", response);
}
```

快照来源优先级：
1. 内存中的 `routines` ConcurrentMap（当前运行中）
2. Redis key `etetet:agentic:runtime:{conversationId}`（TTL 30 分钟）

### 2.8 Token 持久化

**文件**: `etetet-biz/.../agent/AbstractAgent.java`

```java
// saveAnswerMessage() 方法
String ctxJson = Jackson.toJson(ctxMap);  // 包含 llmContextTokens
message.setCtx(ctxJson);
```

Token 数被写入消息的 `ctx` JSON 字段，后续可通过 `LlmTokenEstimator.extractContextTokens()` 读取。

## 三、数据流时序图

```
┌─────────┐     ┌─────────┐     ┌──────────────────┐     ┌─────────────────────┐
│  User   │     │ Frontend │     │  Backend Agent   │     │ SessionCompaction   │
│  (UI)   │     │  (Vue)   │     │  (WebSocket)     │     │     Manager         │
└────┬────┘     └────┬─────┘     └────────┬─────────┘     └──────────┬──────────┘
     │               │                    │                          │
     │  发送消息      │                    │                          │
     │──────────────►│                    │                          │
     │               │  send(query)       │                          │
     │               │──────────────────►│                          │
     │               │                    │                          │
     │               │                    │  compactIfNeeded()       │
     │               │                    │◄─────────────────────────│
     │               │                    │                          │
     │               │                    │  estimatePromptInputTokens()
     │               │                    │─────────────────────────►│
     │               │                    │  totalTokens             │
     │               │                    │◄─────────────────────────│
     │               │                    │                          │
     │               │  ctxWindow         │                          │
     │               │  {inputTokens}     │                          │
     │               │◄──────────────────│                          │
     │               │                    │                          │
     │               │  syncSessionLastContextTokens(tokens)         │
     │               │──────┐             │                          │
     │               │      │             │                          │
     │               │◄─────┘             │                          │
     │               │                    │                          │
     │  更新显示      │                    │                          │
     │  "上下文 12.3k"│                    │                          │
     │◄──────────────│                    │                          │
     │               │                    │                          │
```

## 四、关键文件索引

### 前端
| 文件 | 职责 |
|------|------|
| `acg-dama-web/src/views/home/components/AiChatHome.vue` | 主界面，展示上下文标签，处理 WebSocket 消息 |

### 后端
| 文件 | 职责 |
|------|------|
| `etetet-common/.../SseEvent.java` | 定义 `ctxWindow` 事件类型枚举 |
| `etetet-biz/.../agent/AbstractAgent.java` | `emitCtxWindow()` 发送逻辑 |
| `etetet-biz/.../support/LlmTokenEstimator.java` | 基于 cl100k 的 Token 估算核心 |
| `etetet-biz/.../manager/SessionCompactionManager.java` | 压缩决策中的 Token 估算和 ctxWindow 触发 |
| `etetet-biz/.../agent/runtime/ConversationRuntimeManager.java` | 构建 runtimeSnapshot，读取 inputTokens |
| `etetet-biz/.../agent/runtime/ConversationRuntimeSnapshot.java` | 运行时快照 DTO |
| `etetet-web/.../action/WsAction.java` | WebSocket bind 操作，返回 runtimeSnapshot |
| `etetet-dal/.../entity/agent/AiSessionCompaction.java` | 压缩记录实体，持久化 inputTokens |

## 五、技术要点总结

1. **Token 计算**: 使用 jtokkit 库的 `cl100k_base` 编码器，与 OpenAI GPT 系列模型使用相同的分词算法，确保估算准确性。异常时降级为 `文本长度 / 4` 的粗略估算。

2. **实时推送**: 通过 WebSocket 的 `ctxWindow` 命令，在会话压缩和工具循环压缩的关键节点主动推送 Token 数量变化。

3. **状态恢复**: 通过 `bindResponse` 中的 `runtimeSnapshot`，在前端重连或切换会话时恢复最新的 Token 数量。

4. **数据一致性**: `inputTokens` 同时存在于 context metadata（内存）和消息 ctx（持久化）中，确保运行时和历史查询都能获取到 Token 信息。

5. **压缩联动**: Token 计算与上下文压缩机制紧密集成，压缩前后的 Token 变化会实时推送给前端，让用户感知到压缩带来的上下文释放。
