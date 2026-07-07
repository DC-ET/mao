# Agent 向用户提问 — 技术方案设计

> 版本: v1.0 | 日期: 2026-06-24 | 状态: 待评审

## 1. 需求概述

Agent 在执行任务过程中，需要在不中断任务流的情况下向用户发起提问，用于：

- 获取用户偏好或需求澄清
- 模糊指令的二次确认
- 实现方案的多选一决策
- 提供选项让用户选择方向

底层基于 ToolCall 机制实现，工具名为 `ask_user_questions`。

## 2. 核心设计思路

### 2.1 与现有机制的类比

本功能在架构上与 **LOCAL 模式工具审批流** 高度相似：


| 维度    | 工具审批 (approval)         | 向用户提问 (ask_user_questions) |
| ----- | ----------------------- | -------------------------- |
| 触发方   | ToolDispatcher 根据权限判断   | LLM 主动调用工具                 |
| 阻塞方式  | CompletableFuture.get() | CompletableFuture.get()    |
| 客户端渲染 | ApprovalStack 卡片        | QuestionPanel 问答面板         |
| 用户操作  | 批准 / 拒绝                 | 选择选项 / 自由输入                |
| 返回值   | 执行结果或拒绝错误               | 用户回答的结构化 JSON              |
| 执行模式  | 仅 LOCAL 模式              | **CLOUD 和 LOCAL 均可**       |


关键区别：审批是安全机制，由 ToolDispatcher 根据权限等级决定；提问是能力工具，由 LLM 自主决定何时调用。因此提问工具需要**独立于权限系统**，在任何执行模式下都能将问题路由到客户端。

### 2.2 端到端流程

```
LLM 输出 tool_call: ask_user_questions
    │
    ▼
AgentLoop.executeToolCalls()
    │
    ▼
ToolDispatcher.dispatch()
    │  识别为特殊工具，路由到客户端
    ▼
发送 ask_user_questions WsEvent → 客户端
    │
    ▼
客户端渲染 QuestionPanel 组件
    │  用户选择选项 或 输入自定义文本
    ▼
客户端发送 ask_user_questions_result WsEvent → 服务端
    │
    ▼
CompletableFuture 完成，AgentLoop 继续
    │
    ▼
LLM 收到 tool_result，继续执行任务
```

## 3. 后端设计

### 3.1 新增工具：AskUserQuestionsTool

**文件**: `backend/src/main/java/cn/etarch/mao/harness/tool/impl/AskUserQuestionsTool.java`

```java
@Component
public class AskUserQuestionsTool implements Tool {

    @Override
    public String getName() {
        return "ask_user_questions";
    }

    @Override
    public String getDescription() {
        return """
            Use this tool when you need to ask the user questions during execution. \
            This allows you to gather user preferences or requirements, clarify ambiguous \
            instructions, get decisions on implementation choices as you work, or offer \
            choices to the user about what direction to take.
            \
            Usage notes:
            - Users will always be able to select "Other" to provide custom text input
            - Use multiSelect: true to allow multiple answers to be selected
            - If you recommend a specific option, make it the first in the list and add \
              "(Recommended)" at the end of the label
            - preview supports rendered markdown in a monospace box, multi-line with newlines
            - Previews only render for single-select questions (not multiSelect)
            - When any option has preview, UI switches to side-by-side layout
            """;
    }

    @Override
    public Map<String, Object> getInputSchema() {
        // 返回 JSON Schema，详见下方
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        // 返回 JSON Schema
    }

    @Override
    public String execute(String arguments, Long sessionId, String workspace) {
        // 此方法不应被直接调用 — 由特殊路由处理
        // 如果被调用，返回错误提示
        return "{\"error\": \"ask_user_questions must be dispatched to client\"}";
    }
}
```

**Input Schema**:

```json
{
  "type": "object",
  "required": ["questions"],
  "properties": {
    "questions": {
      "type": "array",
      "minItems": 1,
      "maxItems": 4,
      "items": {
        "type": "object",
        "required": ["question", "header", "options", "multiSelect"],
        "properties": {
          "question": {
            "type": "string",
            "description": "The complete question, ending with ?"
          },
          "header": {
            "type": "string",
            "maxLength": 12,
            "description": "Very short label, shown as chip/tag"
          },
          "options": {
            "type": "array",
            "minItems": 2,
            "maxItems": 4,
            "items": {
              "type": "object",
              "required": ["label", "description"],
              "properties": {
                "label": {
                  "type": "string",
                  "description": "Display text, 1-5 words"
                },
                "description": {
                  "type": "string",
                  "description": "Explanation of what this option means"
                },
                "preview": {
                  "type": "string",
                  "description": "Optional preview content (mockups, code, diagrams)"
                }
              }
            }
          },
          "multiSelect": {
            "type": "boolean",
            "description": "true = multiple answers allowed"
          }
        }
      }
    },
    "metadata": {
      "type": "object",
      "description": "Optional tracking metadata"
    }
  }
}
```

**Output Schema**:

```json
{
  "type": "object",
  "properties": {
    "answers": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "question": { "type": "string" },
          "selectedLabels": {
            "type": "array",
            "items": { "type": "string" }
          },
          "customInput": { "type": "string" }
        }
      }
    }
  }
}
```

### 3.2 ToolDispatcher 路由改造

**文件**: `backend/src/main/java/cn/etarch/mao/harness/tool/ToolDispatcher.java`

新增特殊路由判断。`ask_user_questions` 不属于 `SERVER_ONLY_TOOLS`（那组是 task_* 工具），需要独立处理：

```java
// 新增常量
private static final String ASK_USER_QUESTIONS = "ask_user_questions";

// dispatch() 方法中新增分支（在 SERVER_ONLY_TOOLS 判断之后）
if (ASK_USER_QUESTIONS.equals(toolName)) {
    return dispatchAskUserQuestions(arguments, sessionId, workspace);
}
```

`dispatchAskUserQuestions()` 方法实现：

1. 生成 `requestId`（UUID）
2. 构建 `WsEvent`（type = `ask_user_questions`），data 中包含 `requestId` + 工具参数
3. 通过 `StreamingWsRegistry.send()` 发送给用户
4. 创建 `CompletableFuture<String>` 并注册到一个专用的 `AskUserQuestionsRegistry`
5. 阻塞等待 `future.get()`，设置超时（默认 5 分钟）
6. 超时返回 `{"error": "User did not respond within timeout"}`

**为什么不用 LocalToolExecutor**: LocalToolExecutor 绑定了 LOCAL 模式的连接管理（检查客户端是否在线、发送 tool_execute 事件），而提问工具需要在 CLOUD 模式下也能工作。需要独立的发送/等待机制。

### 3.3 新增 AskUserQuestionsRegistry

**文件**: `backend/src/main/java/cn/etarch/mao/harness/tool/AskUserQuestionsRegistry.java`

```java
@Component
public class AskUserQuestionsRegistry {

    // key: (sessionId, requestId) -> CompletableFuture<String>
    private final Map<String, CompletableFuture<String>> pending = new ConcurrentHashMap<>();

    public CompletableFuture<String> register(Long sessionId, String requestId) {
        CompletableFuture<String> future = new CompletableFuture<>();
        pending.put(key(sessionId, requestId), future);
        return future;
    }

    public void complete(Long sessionId, String requestId, String result) {
        CompletableFuture<String> future = pending.remove(key(sessionId, requestId));
        if (future != null) {
            future.complete(result);
        }
    }

    public void failAllForSession(Long sessionId) {
        // 会话取消时，清理所有待响应的提问
        pending.entrySet().removeIf(e -> {
            if (e.getKey().startsWith(sessionId + ":")) {
                e.getValue().complete("{\"error\": \"Session cancelled\"}");
                return true;
            }
            return false;
        });
    }

    private String key(Long sessionId, String requestId) {
        return sessionId + ":" + requestId;
    }
}
```

### 3.4 WebSocket 协议扩展

**新增事件类型**:


| 方向              | type                        | data 字段                              | 说明   |
| --------------- | --------------------------- | ------------------------------------ | ---- |
| Server → Client | `ask_user_questions`        | `{ requestId, questions, metadata }` | 发送提问 |
| Client → Server | `ask_user_questions_result` | `{ requestId, answers }`             | 返回回答 |


**WsEvent 示例 — Server → Client**:

```json
{
  "type": "ask_user_questions",
  "sessionId": 123,
  "data": {
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "questions": [
      {
        "question": "Which framework should we use for the new module?",
        "header": "Framework",
        "options": [
          { "label": "Vue 3 (Recommended)", "description": "Composition API + TypeScript, matches existing stack" },
          { "label": "React", "description": "Larger ecosystem but different from current codebase" }
        ],
        "multiSelect": false
      }
    ]
  }
}
```

**WsEvent 示例 — Client → Server**:

```json
{
  "type": "ask_user_questions_result",
  "sessionId": 123,
  "data": {
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "answers": [
      {
        "question": "Which framework should we use for the new module?",
        "selectedLabels": ["Vue 3 (Recommended)"],
        "customInput": null
      }
    ]
  }
}
```

### 3.5 StreamingWsHandler 处理

**文件**: `backend/src/main/java/cn/etarch/mao/session/ws/StreamingWsHandler.java`

在 `handleTextMessage()` 的 switch 分支中新增：

```java
case "ask_user_questions_result" -> handleAskUserQuestionsResult(sessionId, data);
```

`handleAskUserQuestionsResult()` 实现：

1. 从 data 中提取 `requestId` 和 `answers`
2. 将 answers 序列化为 JSON 字符串
3. 调用 `askUserQuestionsRegistry.complete(sessionId, requestId, jsonResult)`

### 3.6 取消处理

在 `StreamingWsHandler.handleCancel()` 中，除了现有的 `localToolSessionRegistry.failAllForUser()` 外，新增：

```java
askUserQuestionsRegistry.failAllForSession(sessionId);
```

确保取消时 AgentLoop 中阻塞的 CompletableFuture 能被释放。

### 3.7 AgentLoop 无感知

AgentLoop 本身**不需要任何改动**。它只看到：

1. `dispatchTool()` 返回了一个 JSON 字符串（用户的回答）
2. 将结果加入 context，继续循环

这与现有工具执行模式完全一致。

### 3.8 ToolResultSummarizer 扩展

**文件**: `backend/src/main/java/cn/etarch/mao/session/util/ToolResultSummarizer.java`

新增对 `ask_user_questions` 的摘要生成：

```java
case "ask_user_questions" -> {
    // 解析 answers，生成类似 "回答了 2 个问题" 的摘要
    yield "回答了 " + answerCount + " 个问题";
}
```

## 4. 桌面端设计

### 4.1 WebSocket 事件路由

**文件**: `desktop/src/composables/useStreamWS.ts`

在 `routeEvent()` 中新增 case：

```typescript
case 'ask_user_questions':
  sessionStore.appendAskQuestion(event.data)
  break
```

**文件**: `desktop/src/stores/session.ts`

新增 store 方法 `appendAskQuestion(data)`：

- 将提问数据存入当前活跃会话的 `pendingQuestions` 队列
- 类似于 `pendingApprovals` 的管理模式

### 4.2 新增 QuestionPanel 组件

**文件**: `desktop/src/components/chat/QuestionPanel.vue`

渲染位置：与 `ApprovalStack` 同级，位于聊天区域底部或消息流中。

**UI 结构**:

```
┌─────────────────────────────────────────────────┐
│  Agent wants to know:                           │
│                                                 │
│  ┌─ Framework ─────────────────────────────┐    │
│  │ Which framework should we use for the   │    │
│  │ new module?                             │    │
│  │                                         │    │
│  │ ○ Vue 3 (Recommended)                   │    │
│  │   Composition API + TypeScript,         │    │
│  │   matches existing stack                │    │
│  │                                         │    │
│  │ ○ React                                 │    │
│  │   Larger ecosystem but different from   │    │
│  │   current codebase                      │    │
│  │                                         │    │
│  │ ┌─ Other ──────────────────────────┐    │    │
│  │ │ Type your own answer...          │    │    │
│  │ └──────────────────────────────────┘    │    │
│  └─────────────────────────────────────────┘    │
│                                                 │
│                              [ Submit ]          │
└─────────────────────────────────────────────────┘
```

**带 Preview 的 side-by-side 布局**:

```
┌──────────────────────────────────────────────────────┐
│  Agent wants to know:                                │
│                                                      │
│  ┌─ Layout ───────────────────┬─ Preview ──────────┐ │
│  │ Which layout approach?     │ ┌────────────────┐ │ │
│  │                            │ │ // mockup code  │ │ │
│  │ ○ Sidebar (Recommended)    │ │ <div class="s"> │ │ │
│  │   Fixed left panel         │ │   <aside/>      │ │ │
│  │                            │ │   <main/>       │ │ │
│  │ ○ Top bar                  │ │ </div>          │ │ │
│  │   Horizontal navigation    │ │                 │ │ │
│  │                            │ └────────────────┘ │ │
│  │ ┌─ Other ──────────────┐   │                    │ │
│  │ │ Type your answer...  │   │                    │ │
│  │ └──────────────────────┘   │                    │ │
│  └────────────────────────────┴────────────────────┘ │
│                                                      │
│                                         [ Submit ]   │
└──────────────────────────────────────────────────────┘
```

**Multi-select 布局**:

```
┌─────────────────────────────────────────────────┐
│  Agent wants to know:                           │
│                                                 │
│  ┌─ Features ──────────────────────────────┐    │
│  │ Which features should we include?       │    │
│  │                                         │    │
│  │ ☑ Dark mode                             │    │
│  │   Toggle between light and dark themes  │    │
│  │                                         │    │
│  │ ☐ i18n support                          │    │
│  │   Multi-language internationalization   │    │
│  │                                         │    │
│  │ ☑ Export to PDF                         │    │
│  │   Generate PDF reports                  │    │
│  │                                         │    │
│  │ ┌─ Other ──────────────────────────┐    │    │
│  │ │ Type your own answer...          │    │    │
│  │ └──────────────────────────────────┘    │    │
│  └─────────────────────────────────────────┘    │
│                                                 │
│                              [ Submit ]          │
└─────────────────────────────────────────────────┘
```

### 4.3 组件接口设计

```typescript
interface QuestionOption {
  label: string
  description: string
  preview?: string
}

interface Question {
  question: string
  header: string
  options: QuestionOption[]
  multiSelect: boolean
}

interface QuestionAnswer {
  question: string
  selectedLabels: string[]
  customInput: string | null
}

interface PendingQuestion {
  requestId: string
  questions: Question[]
  metadata?: Record<string, unknown>
}
```

### 4.4 用户交互逻辑

**单选 (multiSelect: false)**:

- 点击选项切换选中状态（radio 行为）
- 同一问题只能选中一个选项
- "Other" 输入框始终可见，输入文本时自动取消选项选中
- 选中选项时清空 "Other" 输入框
- Submit 按钮在至少选中一个选项或 "Other" 有内容时可用

**多选 (multiSelect: true)**:

- 点击选项切换选中状态（checkbox 行为）
- 可选中多个选项
- "Other" 输入框始终可见
- Submit 按钮在至少选中一个选项或 "Other" 有内容时可用

**Preview 渲染**:

- 仅在单选模式且选项含 preview 时渲染
- 切换到 side-by-side 布局
- 预览内容以 markdown 渲染在 monospace 容器中
- 选中不同选项时，右侧预览跟随切换

### 4.5 回答提交

用户点击 Submit 后：

1. 收集所有问题的回答，构建 `answers` 数组
2. 通过 useStreamWS 发送 `ask_user_questions_result` 事件：
   ```typescript
   ws.send(JSON.stringify({
     type: 'ask_user_questions_result',
     sessionId: activeSessionId,
     data: {
       requestId: pendingQuestion.requestId,
       answers: collectedAnswers
     }
   }))
   ```
3. 从 store 中移除该 pendingQuestion，QuestionPanel 消失

回答不需要以用户消息形式插入消息流。tool_call（包含问题）和 tool_result（包含回答）已完整记录在消息历史中，ToolCallCard 的 Input/Output 区域即可展示问答详情。

### 4.6 与 ApprovalStack 的共存

QuestionPanel 和 ApprovalStack 是独立的交互通道，可以同时存在：

- ApprovalStack 处理工具执行审批（安全机制）
- QuestionPanel 处理 Agent 提问（信息收集）

两者在 UI 上不冲突，各自管理自己的队列。当同时存在时，QuestionPanel 显示在 ApprovalStack 上方（因为提问通常更紧急，需要用户关注）。

## 5. 数据持久化

### 5.1 消息存储

提问和回答作为普通的 tool_call + tool_result 对存储，无需新增表或字段：

- **Assistant 消息**：包含 `tool_call` 记录，toolName = `ask_user_questions`，arguments = 完整的 questions JSON
- **Tool 消息**：role = `TOOL`，toolCallId 关联到上述 tool_call，content = answers JSON

现有消息查询和回放机制自动支持。

### 5.2 历史回放

当用户重新打开会话或刷新页面时：

- 消息从 DB 加载，`ask_user_questions` 的 tool_call 和 tool_result 正常展示在 ToolCallCard 中
- 不会重新弹出 QuestionPanel（那是实时交互组件）

## 6. 边界情况处理

### 6.1 超时

- 默认超时：5 分钟
- 超时后返回 `{"error": "User did not respond within timeout"}`
- LLM 收到超时错误后可自行决定是否重试或换一种方式继续
- 超时时间可通过 application.yml 配置

### 6.2 会话取消

- 用户取消时，`failAllForSession()` 释放所有阻塞的 CompletableFuture
- 返回 `{"error": "Session cancelled"}`
- AgentLoop 检测到取消标志后退出循环

### 6.3 WebSocket 断连

- 客户端断连时，服务端的 CompletableFuture 仍阻塞
- 超时机制作为兜底
- 可选：在 WebSocket close handler 中也触发 failAllForSession

### 6.4 多设备

- 同一用户多设备登录时，`StreamingWsRegistry.send()` 会广播到所有连接
- 任一设备回答即可，先到先得
- 其他设备收到回答后应清除本地的 QuestionPanel

### 6.5 队列消息

- 当 Agent 正在等待用户回答时，新消息应进入队列（与 RUNNING 状态一致）
- 用户回答后 Agent 继续执行，完成后自动消费队列

## 7. 文件变更清单

### 后端


| 文件                                            | 变更类型   | 说明                              |
| --------------------------------------------- | ------ | ------------------------------- |
| `harness/tool/impl/AskUserQuestionsTool.java` | **新增** | 工具定义                            |
| `harness/tool/AskUserQuestionsRegistry.java`  | **新增** | 提问等待注册表                         |
| `harness/tool/ToolDispatcher.java`            | 修改     | 新增 ask_user_questions 路由分支      |
| `session/ws/StreamingWsHandler.java`          | 修改     | 处理 ask_user_questions_result 事件 |
| `session/ws/WsEvent.java`                     | 无变更    | WsEvent 是通用 envelope，无需改        |
| `session/util/ToolResultSummarizer.java`      | 修改     | 新增 ask_user_questions 摘要        |
| `harness/core/AgentLoop.java`                 | 无变更    | 无需感知此工具                         |
| `application.yml`                             | 修改     | 新增超时配置项（可选）                     |


### 桌面端


| 文件                                  | 变更类型   | 说明                        |
| ----------------------------------- | ------ | ------------------------- |
| `components/chat/QuestionPanel.vue` | **新增** | 提问渲染组件                    |
| `composables/useStreamWS.ts`        | 修改     | 路由 ask_user_questions 事件  |
| `stores/session.ts`                 | 修改     | 新增 pendingQuestions 状态和方法 |
| `types/chat.ts`                     | 修改     | 新增 Question 相关类型定义        |
| `composables/useChat.ts`            | 修改     | 提问回答提交逻辑                  |
| `components/chat/MessageBubble.vue` | 可选修改   | 提问工具调用的展示优化               |


### 管理后台

无变更。管理后台不涉及实时对话交互。

## 8. 实施计划

一次性实施落地，包含以下工作项：

**后端**：
1. 新增 `AskUserQuestionsTool` — 工具定义（name、description、inputSchema、outputSchema）
2. 新增 `AskUserQuestionsRegistry` — 提问等待注册表（CompletableFuture 管理）
3. 修改 `ToolDispatcher` — 新增 `ask_user_questions` 路由分支，绕过权限系统直接路由到客户端
4. 修改 `StreamingWsHandler` — 处理 `ask_user_questions_result` 事件 + 取消时 failAll
5. 修改 `ToolResultSummarizer` — 新增 `ask_user_questions` 摘要

**桌面端**：
6. 新增 `QuestionPanel.vue` — 提问渲染组件，支持单选/多选/自由输入/preview side-by-side 布局
7. 修改 `useStreamWS.ts` — 路由 `ask_user_questions` 事件到 store
8. 修改 `session.ts` — 新增 `pendingQuestions` 状态和 `appendAskQuestion` / `removeAskQuestion` 方法
9. 修改 `chat.ts` — 新增 Question 相关 TypeScript 类型定义
10. 修改 `useChat.ts` — 提问回答提交逻辑
11. 修改 `TaskView.vue` — 在聊天区域底部挂载 `QuestionPanel`，与 `ApprovalStack` 同级

**不包含**：压力测试、单元测试、管理后台变更。

## 9. 设计决策记录

| # | 问题 | 决策 |
|---|------|------|
| 1 | 回答是否以用户消息形式插入消息流？ | **否**。tool_call + tool_result 已包含完整问答，无需额外插入用户消息 |
| 2 | 是否限制提问频率？ | **不限制**。LLM 可在一轮对话中多次调用此工具 |
| 3 | QuestionPanel 的位置？ | **固定在聊天区域底部**（类似 ApprovalStack），长对话时不会被滚动出视野 |
| 4 | "Other" 输入是否需要非空校验？ | **是**。选中 "Other" 但未输入内容时，Submit 按钮禁用 |

