# 边路任务（Side Task）技术方案

> 版本: v2.0 | 更新时间: 2026-07-04

---

## 1. 需求背景

### 1.1 问题描述

当前用户在桌面端进行主任务对话时，如果临时需要执行一个独立的操作（如部署、代码提交推送等），只有两种方式：

1. **在当前会话中直接发送指令**——但这会污染主任务上下文，部署日志、git 输出等无关信息会混入对话历史，影响后续 Agent 的理解和判断。
2. **手动创建一个新会话**——这会导致会话列表充满大量一次性临时会话，管理混乱。

缺少一种"临时、隔离、即用即抛"的任务执行通道。

### 1.2 核心需求

| 需求项 | 说明 |
|--------|------|
| **边路发起** | 用户在主任务对话过程中，通过 UI 手动发起一个边路任务 |
| **上下文隔离** | 边路任务的执行过程和结果不写入主任务上下文，不影响主任务的历史消息 |
| **多轮对话** | 边路任务支持多轮对话，用户可以追加回复，Agent 执行完整的 Think-Act-Observe 循环 |
| **完整工具循环** | 边路任务走完整的 Agent Loop（Think-Act-Observe 多轮），支持 shell、git 等工具调用 |
| **并行执行** | 边路任务异步执行，不阻塞主任务继续运行 |
| **配置继承** | 边路任务复用当前主任务的 Agent、模型和工作区配置，用户不可修改 |
| **上下文可选继承** | 用户每次可选择是否让边路任务感知主任务的对话历史摘要（帮助边路 Agent 理解背景） |
| **Tab 式 UI** | 边路任务作为中央区域的 Tab 管理，与文件预览、Diff 对比等 Tab 并列，不新增独立面板 |

### 1.3 边界说明

| 要做的 | 不做的 |
|--------|--------|
| 用户在 UI 上手动发起边路任务 | Agent 在对话中通过工具调用发起边路任务 |
| 边路任务走完整 Agent Loop（Think-Act-Observe） | 仅做单次 LLM 调用不执行工具 |
| 边路任务结果展示在独立 Tab 中 | 边路任务结果注入主任务上下文 |
| 边路任务支持多轮对话（用户可追加回复） | — |
| 复用主任务 Agent/模型/工作区 | 允许在边路任务中切换 Agent/模型 |
| 边路任务使用独立 session 存储，`session_type = 'side_task'` | 边路任务消息写回主会话 |
| 边路任务 Tab 可关闭，关闭后数据保留 | 关闭 Tab 时删除会话数据 |
| 桌面端（Electron）支持 | 管理后台（Admin）支持边路任务 |

---

## 2. 需求描述

### 2.1 用户故事

> 作为开发者，我在主任务对话中让 Agent 帮我开发功能时，想临时让 Agent 执行一次 `git add . && git commit -m "xxx" && git push`。我希望这个操作不影响当前对话上下文，不污染会话列表，可以追加对话直到任务完成，完成后关闭 Tab 即消失。

### 2.2 交互流程

```
用户在聊天界面（主任务 Tab）
    │
    ├── 点击工具栏「+ 边路任务」按钮
    │     │
    │     └── 创建新的「边路任务」Tab（如 "[边路] git 提交"）
    │           │
    │           ├── Tab 内展示：历史消息区域 + 输入框
    │           │
    │           ├── 首条消息发送时：
    │           │   ├── ☑️ 继承主任务上下文（checkbox，默认勾选，发送后隐藏）
    │           │   └── 后端创建 side_task 子会话，启动 Agent 执行
    │           │
    │           ├── 边路任务异步执行，实时流式展示
    │           ├── 主任务 Tab 不受影响，可切换到主 Tab 继续对话
    │           │
    │           ├── 边路任务完成后：
    │           │   ├── 用户可以追加回复（继续多轮对话）
    │           │   └── 追加消息走标准 send_message 流程（用 side_session_id）
    │           │
    │           └── 用户关闭 Tab → Tab 移除，会话数据保留在 DB
    │
    └── 所有边路任务 Tab 与文件预览/Diff Tab 并列显示在 Tab Bar
```

### 2.3 核心用例

1. **代码提交推送**：主任务开发完后，边路任务执行 `git add/commit/push`
2. **部署操作**：主任务开发完成后，边路任务执行构建和部署命令
3. **快速查询**：临时查一个不相关的信息，不想混入主对话上下文
4. **文件清理 / 辅助操作**：整理工作区文件、运行脚本等

---

## 3. 技术选型

### 3.1 整体思路

边路任务本质是一个**用户手动触发的、独立会话的、Tab 内展示的 Agent 对话**。创建时特殊处理（关联父会话 + 可选继承上下文），后续消息复用现有的 `send_message` → `handleSendMessage` 标准流程。

与现有概念对比：

| 维度 | 普通会话 | 子智能体（DelegateTool） | 边路任务（新增） |
|------|---------|------------------------|-----------------|
| 触发方 | 用户新建 | 主 Agent 工具调用 | 用户点击工具栏按钮 |
| UI 形态 | 会话列表切换 | **只读中央 Tab**（`subagent`） | **中央 Tab 管理** |
| 结果去向 | 写入自身 session | 注入主对话上下文（tool_result） | 仅在边路 Tab 展示 |
| 上下文 | 完整历史 | 主 Agent 编写的 prompt | **可选继承**主任务摘要 |
| 多轮对话 | 支持 | 单轮（用完即弃，不可追问） | **支持** |
| 会话类型 | `main` | `subagent` | `side_task` |
| 消息可见性 | 会话列表 | **只读 Tab + 右侧子代理列表** | **Tab 内，不在会话列表** |

### 3.2 复用策略

| 组件 | 复用方式 |
|------|---------|
| `AgentLoop` | 直接复用，`execute()` 执行边路任务 |
| `HarnessService.buildContext()` | 复用，构建边路任务的 `AgentExecutionContext` |
| `agentExecutor` 线程池 | 复用，边路任务提交到同一线程池 |
| `StreamingWsHandler.handleSendMessage()` | 复用，后续多轮消息走标准流程 |
| `Session` / `Message` 表 | 复用，边路任务创建独立 session 记录 |
| 前端 `useCenterTabs` | 扩展，新增 `side_task` Tab 类型 |
| 前端 `ChatPanel` | 参考实现新的 `SideChatPanel`，复用 message 渲染组件 |
| 前端 `sessionStore` | 扩展，支持按 sessionId 存取消息缓存 |

### 3.3 不做的新增

- **不新增执行引擎**：边路任务完全复用 `AgentLoop`
- **不修改 PromptEngine**：边路任务的 system prompt 沿用主 Agent 配置
- **不新增数据库表**：复用 `session` 和 `message` 表，通过 `session_type` 字段区分
- **不新增 WS 事件类型用于后续消息**：后续多轮消息直接用标准 `send_message`

---

## 4. 架构设计

### 4.1 整体架构

```
┌──────────────────────────────────────────────────────────────────────┐
│  桌面端 (Electron + Vue 3)                                            │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  CenterTabBar                                                    │  │
│  │  ┌────────┬──────────────────────┬──────────┬───────────────┐  │  │
│  │  │ 聊天   │ [边路] git 提交 ✕    │ main.ts  │ package.json  │  │  │
│  │  │ (主)   │ (side_task tab)     │ (file)   │ (file)        │  │  │
│  │  └────────┴──────────────────────┴──────────┴───────────────┘  │  │
│  └────────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  CenterTabContainer                                             │  │
│  │                                                                 │  │
│  │  activeTab === 'chat'    → ChatPanel (主任务，不变)              │  │
│  │  activeTab === 'file'    → FileViewer (文件，不变)               │  │
│  │  activeTab === 'diff'    → FileDiffViewer (Diff，不变)          │  │
│  │  activeTab === 'side_task' → SideChatPanel (边路对话，新增)     │  │
│  └────────────────────────────────────────────────────────────────┘  │
│           │                                                          │
│           │ WebSocket (订阅 parentSessionId + 各 sideSessionId)      │
└───────────┼──────────────────────────────────────────────────────────┘
            │
┌───────────┼──────────────────────────────────────────────────────────┐
│  后端     │                                                           │
│           │                                                           │
│  ┌────────┴──────────────────────────────────────────────────────┐   │
│  │  StreamingWsHandler                                            │   │
│  │  ┌───────────────────────────────────────┐                    │   │
│  │  │ handleCreateSideSession (新增)         │  创建子会话         │   │
│  │  │  → 创建 side_task session             │  +首条消息执行     │   │
│  │  │  → 保存首条 USER 消息                  │                    │   │
│  │  │  → 异步启动 Agent Loop                 │                    │   │
│  │  └───────────────────────────────────────┘                    │   │
│  │  ┌───────────────────────────────────────┐                    │   │
│  │  │ handleSendMessage (已有，不改动)        │  后续多轮消息      │   │
│  │  │  → 按 sessionId 路由到普通或边路会话    │  走标准流程        │   │
│  │  └───────────────────────────────────────┘                    │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  HarnessService                                                │   │
│  │  - executeFromEvent() (已有，边路后续消息复用)                   │   │
│  │  - executeSideFirstMessage() (新增，首条消息 + inheritContext)   │   │
│  │  - buildContext() (改为 public)                                 │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Session 表 (复用)                                             │   │
│  │  - session_type = 'side_task'                                  │   │
│  │  - parent_session_id → 主会话 ID                               │   │
│  │  - inherit_context (JSONB/config 字段)                          │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

### 4.2 执行时序

#### 首条消息（创建边路任务）

```
用户                   前端                             后端
 │                      │                                │
 │── 新建边路任务Tab ──>│                                │
 │                      │ 创建 Tab (type=side_task)      │
 │                      │                                │
 │── 输入并发送 ───────>│                                │
 │                      │ WS: create_side_session ──────>│
 │                      │  {parentSessionId,              │
 │                      │   content, inheritContext}      │
 │                      │                                │── 创建 side_task session
 │                      │                                │── 保存 USER 消息到子会话
 │                      │                                │── 若 inheritContext:
 │                      │                                │    生成父会话上下文摘要
 │                      │                                │── 提交 agentExecutor
 │                      │                                │
 │                      │<── side_session_created ───────│
 │                      │  {sideSessionId}               │
 │                      │                                │
 │                      │ 订阅 sideSessionId ────────────>│
 │                      │                                │
 │                      │<── content_delta ──────────────│  (标准事件，用sideSessionId)
 │                      │<── tool_call_start ────────────│
 │                      │<── tool_call_result ───────────│
 │                      │<── ...                         │
 │                      │<── session_status(COMPLETED) ──│
 │                      │                                │
 │  用户查看结果 <──────│                                │
```

#### 后续消息（多轮对话）

```
用户                   前端                             后端
 │                      │                                │
 │── 在边路Tab中 ──────>│                                │
 │   追加回复            │                                │
 │                      │ WS: send_message ─────────────>│
 │                      │  {sessionId: sideSessionId,     │
 │                      │   data: {content}}              │
 │                      │                                │── handleSendMessage()（标准流程）
 │                      │                                │    校验 session 存在
 │                      │                                │    保存 USER 消息
 │                      │                                │    启动 Agent Loop
 │                      │                                │
 │                      │<── content_delta ──────────────│  (标准事件)
 │                      │<── tool_call_start ────────────│
 │                      │<── session_status(COMPLETED) ──│
```

---

## 5. 实现步骤

### 模块 A：数据库变更

#### A1. session 表扩展

边路任务复用现有的 `session` 表。需要 `parent_session_id` 和 `session_type` 字段（如 V040 子智能体方案已增加则可跳过 ALTER）。

**迁移脚本** `V041__add_side_task_support.sql`：

```sql
-- 1. 确保 session_type 支持 'side_task' 值
--    若 V040 已执行，parent_session_id 和 session_type 已存在
ALTER TABLE `session`
    MODIFY COLUMN `session_type` VARCHAR(20) DEFAULT 'main'
    COMMENT '会话类型: main/subagent/side_task';

-- 2. 确认 phase 字段可为 NULL（边路任务不使用 phase 中间状态）
--    V040 应已处理，若未处理则执行：
-- ALTER TABLE `session`
--     MODIFY COLUMN `phase` VARCHAR(20) DEFAULT NULL
--     COMMENT '任务阶段，边路任务/子智能体会话不使用';

-- 3. 边路任务是否需要 inheritContext 标记？
--    方式 A：存入 config 字段（JSONB）— 无需新列
--    方式 B：冗余到 parent_session_id（NULL = 不继承，有值 = 继承）
--    推荐方式 A，利用已有的 config 字段
--    side_task 的首条消息通过 system prompt 注入上下文摘要，
--    后续消息不再注入（由 DB 中的消息历史自然继承）
```

**说明**：
- 边路任务 session 使用 `status` 字段（ACTIVE/COMPLETED/FAILED），不设置 `phase` 字段
- `inheritContext` 仅在**首条消息**时生效，通过 system prompt 注入。后续消息的上下文由 side_task session 自身的消息历史提供
- 边路任务 message 写入 `message` 表，通过 `session_id` 关联到边路任务会话

**注意**：此模块依赖 V040 迁移。如果 V040 尚未执行，需将上述 ALTER 合并到 V040 迁移脚本中。

---

### 模块 B：后端核心逻辑

#### B1. HarnessService — 新增 `executeSideFirstMessage()` 方法

**文件**：`backend/src/main/java/cn/etarch/mao/harness/core/HarnessService.java`

**修改内容**：

1. 将 `buildContext()` 方法改为 `public`（若 V040 子智能体方案尚未执行）
2. 新增 `executeSideFirstMessage()` 方法：

```java
/**
 * 执行边路任务的首条消息。与主任务并行，使用独立的子会话。
 * 首条消息支持注入主任务上下文摘要（仅一次），后续消息走标准 executeFromEvent() 流程。
 *
 * @param parentSessionId 主任务会话 ID
 * @param sideSessionId   边路任务子会话 ID
 * @param inheritContext  是否注入主任务上下文摘要
 * @param listener        边路任务的事件监听器
 * @param cancelFlag      取消标志
 */
public void executeSideFirstMessage(Long parentSessionId,
                                     Long sideSessionId,
                                     boolean inheritContext,
                                     AgentEventListener listener,
                                     AtomicBoolean cancelFlag) {
    // 1. 构建边路任务上下文（复用 buildContext）
    AgentExecutionContext context = buildContext(sideSessionId);

    // 2. 如果选择继承主任务上下文，注入摘要到 system prompt（仅首条消息）
    if (inheritContext) {
        String contextSummary = generateContextSummary(parentSessionId);
        if (contextSummary != null && !contextSummary.isBlank()) {
            String enrichedSystemPrompt = context.getSystemPrompt()
                    + "\n\n<主任务背景摘要>\n"
                    + contextSummary
                    + "\n</主任务背景摘要>\n"
                    + "以上是主任务的最近对话摘要，本次边路任务的结果不需要反馈到主任务。";
            context.setSystemPrompt(enrichedSystemPrompt);
        }
    }

    // 3. 持久化回调：写入边路任务子会话
    AgentLoop.MessagePersistenceCallback persistenceCallback =
        new AgentLoop.MessagePersistenceCallback() {
            @Override
            public void onSaveAssistantMessage(String content, String thinkingContent,
                                                List<ChatRequest.ToolCall> toolCalls,
                                                ChatUsage usage) {
                // ... 同子智能体方案的 createSubPersistenceCallback 逻辑
                String toolCallsJson = null;
                if (toolCalls != null && !toolCalls.isEmpty()) {
                    try {
                        toolCallsJson = objectMapper.writeValueAsString(toolCalls);
                    } catch (JsonProcessingException e) {
                        log.warn("Failed to serialize tool calls for side task", e);
                    }
                }
                int tokenCount = usage != null ? usage.getTotalTokens() : 0;
                Long modelId = context.getModelConfig() != null
                        ? context.getModelConfig().getId() : null;
                sessionService.saveMessage(sideSessionId, "ASSISTANT",
                        content, thinkingContent, null, toolCallsJson,
                        tokenCount, modelId);
            }

            @Override
            public void onSaveToolMessage(String toolCallId, String content) {
                sessionService.saveMessage(sideSessionId, "TOOL",
                        content, null, toolCallId, null, 0, null);
            }
        };

    // 4. 执行 Agent Loop
    agentLoop.execute(context, listener, persistenceCallback);
    if (cancelFlag != null) {
        agentLoop.removeCancelFlag(sideSessionId);
    }
}

/**
 * 生成主任务上下文摘要。
 * 取最近若干条消息的摘要，帮助边路 Agent 理解主任务背景。
 */
private String generateContextSummary(Long parentSessionId) {
    try {
        List<Message> messages = sessionService.getMessages(parentSessionId);
        if (messages.isEmpty()) return null;

        int fromIndex = Math.max(0, messages.size() - 10);
        List<Message> recentMessages = messages.subList(fromIndex, messages.size());

        StringBuilder sb = new StringBuilder();
        sb.append("以下是主任务最近的对话摘要：\n\n");
        for (Message msg : recentMessages) {
            String role = msg.getRole();
            String content = msg.getContent();
            if (content != null && !content.isBlank()) {
                String truncated = content.length() > 300
                        ? content.substring(0, 300) + "..."
                        : content;
                sb.append("[").append(role).append("]: ").append(truncated).append("\n");
            }
        }
        return sb.toString();
    } catch (Exception e) {
        log.warn("Failed to generate context summary for side task", e);
        return null;
    }
}
```

**说明**：`inheritContext` 仅在首条消息时生效。后续消息通过 `executeFromEvent()` 走标准流程，buildContext 从 DB 加载 side_task session 自身的消息历史，不会再注入主任务摘要。

#### B2. StreamingWsHandler — 新增 `handleCreateSideSession` 方法

**文件**：`backend/src/main/java/cn/etarch/mao/session/ws/StreamingWsHandler.java`

**修改内容**：

1. 在 `handleTextMessage()` 的 switch 中新增 case：

```java
case "create_side_session" -> handleCreateSideSession(userId, root);
case "cancel_side_task"     -> handleCancelSideTask(userId, root);
```

2. 新增 `handleCreateSideSession()` 方法：

```java
/**
 * 创建边路任务会话并执行首条消息。
 * 后续消息复用 handleSendMessage() 标准流程（sessionId = sideSessionId）。
 */
private void handleCreateSideSession(Long userId, JsonNode root) {
    Long parentSessionId = getLong(root, "sessionId");
    if (parentSessionId == null) return;

    JsonNode data = root.get("data");
    if (data == null || !data.has("content")) return;
    String content = data.get("content").asText();
    boolean inheritContext = data.has("inheritContext") && data.get("inheritContext").asBoolean();

    // 1. 校验主会话存在
    Session parentSession;
    try {
        parentSession = sessionService.getSession(parentSessionId);
    } catch (Exception e) {
        registry.send(userId, WsEvent.of("error", parentSessionId,
                Map.of("message", "主会话不存在")));
        return;
    }

    // 2. 确认用户订阅了主会话
    registry.subscribe(userId, parentSessionId);

    // 3. 创建边路任务子会话
    Session sideSession = new Session();
    sideSession.setUserId(userId);
    sideSession.setAgentId(parentSession.getAgentId());
    sideSession.setTitle("[边路] " + (content.length() > 30 
            ? content.substring(0, 30) + "..." : content));
    sideSession.setExecutionMode(parentSession.getExecutionMode());
    sideSession.setWorkspace(parentSession.getWorkspace());
    sideSession.setPermissionLevel(parentSession.getPermissionLevel());
    sideSession.setModelId(parentSession.getModelId());
    sideSession.setIsGit(parentSession.getIsGit());
    sideSession.setPlatform(parentSession.getPlatform());
    sideSession.setShellPath(parentSession.getShellPath());
    sideSession.setOsVersion(parentSession.getOsVersion());
    sideSession.setStatus("ACTIVE");
    sideSession.setParentSessionId(parentSessionId);
    sideSession.setSessionType("side_task");
    sessionService.save(sideSession);
    Long sideSessionId = sideSession.getId();

    log.info("Created side task session {} for parent session {}, userId={}, inheritContext={}",
            sideSessionId, parentSessionId, userId, inheritContext);

    // 4. 保存首条 USER 消息
    sessionService.saveMessage(sideSessionId, "USER", content,
            null, null, null, 0, null);

    // 5. 通知前端会话已创建（前端随后订阅该 sideSessionId）
    registry.send(userId, WsEvent.of("side_session_created", parentSessionId,
            Map.of("sideSessionId", sideSessionId, "title", sideSession.getTitle())));

    // 6. 注册取消标志
    AtomicBoolean cancelFlag = agentLoop.registerCancelFlag(sideSessionId);

    // 7. 异步执行首条消息
    agentExecutor.submit(() -> {
        try {
            // 通过标准事件通知执行状态（sessionId = sideSessionId，前端需订阅方可见）
            registry.send(userId, WsEvent.of("session_status", sideSessionId,
                    Map.of("phase", "RUNNING")));

            WsStreamingEventListener listener = new WsStreamingEventListener(
                    registry, activityService, sessionTodoMapper, sessionService,
                    sideSessionId, userId, null);

            harnessService.executeSideFirstMessage(
                    parentSessionId, sideSessionId,
                    inheritContext, listener, cancelFlag);

            if (cancelFlag.get()) {
                sessionService.updateField(sideSessionId, "status", "CANCELLED");
                registry.send(userId, WsEvent.of("session_status", sideSessionId,
                        Map.of("phase", "CANCELLED")));
            } else {
                sessionService.updateField(sideSessionId, "status", "COMPLETED");
                registry.send(userId, WsEvent.of("session_status", sideSessionId,
                        Map.of("phase", "COMPLETED")));
            }
        } catch (Exception e) {
            log.error("Side task execution failed for sideSession {}", sideSessionId, e);
            sessionService.updateField(sideSessionId, "status", "FAILED");
            registry.send(userId, WsEvent.of("error", sideSessionId,
                    Map.of("message", e.getMessage() != null ? e.getMessage() : "未知错误")));
        } finally {
            agentLoop.removeCancelFlag(sideSessionId);
        }
    });
}
```

**关键设计**：
- 首条消息使用 `create_side_session` 事件（专用逻辑：创建会话 + 注入上下文 + 执行）
- **后续消息使用标准的 `send_message` 事件**，`sessionId = sideSessionId`
- `handleSendMessage()` 看到 sideSessionId 不等于主会话 ID，会为其建立独立的 `sessionLock`，**不会阻塞主任务**
- 所有流式事件（`content_delta`、`tool_call_start` 等）使用 `sessionId = sideSessionId` 路由

3. 新增 `handleCancelSideTask()` 方法：

```java
private void handleCancelSideTask(Long userId, JsonNode root) {
    Long sideSessionId = getLong(root, "sideSessionId");
    if (sideSessionId == null) return;

    // 复用现有的 cancel 机制
    AtomicBoolean flag = cancelFlags.get(sideSessionId);
    if (flag != null) {
        flag.set(true);
    }
    Future<?> future = runningTasks.get(sideSessionId);
    if (future != null) {
        future.cancel(false);
    }
    shellSessionManager.closeByConversation(sideSessionId);
}
```

#### B3. StreamingWsHandler.handleSendMessage() — 确认边路会话兼容性

**文件**：`backend/src/main/java/cn/etarch/mao/session/ws/StreamingWsHandler.java`

**无需修改**。`handleSendMessage()` 按 `sessionId` 查找 session、校验状态、加锁执行。因为边路任务的 `sessionLock` 按 `sideSessionId` 建立，与主任务的 `sessionLock(parentSessionId)` 完全独立，天然支持并行。

**唯一需要注意的场景**：边路任务正在执行中（phase = RUNNING），用户又发了一条消息。此时 `handleSendMessage()` 中的校验会拒绝。解决方案：
- 边路任务也使用消息队列（`sessionQueueMessages`），若 busy 则入队
- 或前端判断 sideSession 的 phase，如 busy 则将消息入队
- 推荐复用消息队列机制，无需改动 `handleSendMessage()`

#### B4. SessionService — 新增方法

**文件**：`backend/src/main/java/cn/etarch/mao/session/service/SessionService.java`

**修改内容**：

1. 新增 `updateField()` 方法：

```java
/**
 * 更新 session 单个字段。
 * 边路任务使用此方法更新 status，避免触发 updatePhase() 中的自动消费等逻辑。
 */
public void updateField(Long sessionId, String field, Object value) {
    LambdaUpdateWrapper<Session> wrapper = new LambdaUpdateWrapper<Session>()
            .eq(Session::getId, sessionId);
    switch (field) {
        case "status" -> wrapper.set(Session::getStatus, (String) value);
        case "phase"  -> wrapper.set(Session::getPhase, (String) value);
        default -> throw new IllegalArgumentException("Unsupported field: " + field);
    }
    sessionMapper.update(null, wrapper);
}
```

2. 新增 `save()` 方法（如不存在）：

```java
public void save(Session session) {
    sessionMapper.insert(session);
}
```

3. 修改 `saveMessage()`：跳过边路任务子会话的标题自动生成：

```java
// saveMessage() 中
if (!"subagent".equals(session.getSessionType()) 
        && !"side_task".equals(session.getSessionType())) {
    // 现有标题自动生成逻辑
}
```

---

### 模块 C：前端实现

#### C1. Tab 类型扩展

**文件**：`desktop/src/types/file-browser.ts`

**修改内容**：扩展 `Tab` 类型支持 `side_task`：

```typescript
export interface Tab {
  id: string            // 'chat' | 'file:xxx' | 'diff:xxx' | 'side:123'
  type: 'chat' | 'file' | 'diff' | 'side_task'
  title: string
  filePath?: string
  fileChange?: FileChange
  /** 边路任务子会话 ID（仅 type === 'side_task' 时有效） */
  sideSessionId?: number
}
```

#### C2. useCenterTabs — 新增边路任务 Tab 管理方法

**文件**：`desktop/src/composables/useCenterTabs.ts`

**修改内容**：新增方法：

```typescript
/**
 * 打开边路任务 Tab。如果已存在则直接激活。
 */
function openSideTaskTab(sideSessionId: number, title: string) {
  const state = getSessionState()
  const id = 'side:' + sideSessionId
  const existing = state.tabs.find(t => t.id === id)
  if (existing) {
    state.activeTabId = id
    return
  }
  const newTab: Tab = { id, type: 'side_task', title, sideSessionId }
  state.tabs.push(newTab)
  state.activeTabId = id
}

/**
 * 关闭边路任务 Tab。
 * 注意：关闭 Tab 不删除 session 数据，只是从 Tab 栏移除。
 * 通过 side_session_list 仍可重新打开。
 */
function closeSideTaskTab(sideSessionId: number) {
  const id = 'side:' + sideSessionId
  closeTab(id)
}
```

`closeTab()` 方法已有关闭逻辑，但需确认它不阻止 `side:` 前缀的 Tab 关闭：

```typescript
// closeTab() 中，当前逻辑：
if (tabId === 'chat') return // can't close chat tab
// side_task Tab 不在禁止关闭范围，无需修改
```

#### C3. 新增组件：SideChatPanel

**文件**：`desktop/src/components/chat/SideChatPanel.vue`

**新建**。这是边路任务的对话界面，渲染在 `side_task` 类型 Tab 中。

**设计思路**：由于 `ChatPanel` 与当前活跃主会话（`sessionStore.activeSession`）深度绑定，不便直接复用。`SideChatPanel` 是一个**轻量版 ChatPanel**，接收 `sideSessionId` prop，独立管理自身消息状态和流式渲染。

```vue
<template>
  <div class="side-chat-panel">
    <!-- 首条消息提示（如果还未发送过消息） -->
    <div v-if="messages.length === 0 && !sending" class="side-chat-empty">
      <p>边路任务：独立的对话通道，不影响主任务上下文</p>
      <div class="inherit-toggle">
        <el-checkbox v-model="inheritContext">
          继承主任务上下文（让 Agent 了解主任务背景）
        </el-checkbox>
      </div>
    </div>

    <!-- 消息列表（复用主任务的消息展示组件） -->
    <div class="messages" ref="messagesContainer">
      <MessageBubble
        v-for="msg in messages"
        :key="msg.id"
        :message="msg"
        :show-time="true"
      />
    </div>

    <!-- 输入框 -->
    <div class="input-area">
      <el-input
        v-model="inputText"
        type="textarea"
        :rows="2"
        placeholder="输入边路任务的指令..."
        :disabled="sending"
        @keydown.enter.exact="handleSend"
      />
      <el-button
        type="primary"
        :disabled="!canSend"
        :loading="sending"
        @click="handleSend"
      >
        发送
      </el-button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useSessionStore } from '@/stores/session'
import { useStreamWS } from '@/composables/useStreamWS'
import type { ChatMessage } from '@/types/chat'
import MessageBubble from './MessageBubble.vue'

const props = defineProps<{
  sideSessionId: number
}>()

const sessionStore = useSessionStore()
const { send, subscribe, unsubscribe } = useStreamWS()

// 首条消息特殊处理
const inheritContext = ref(true)   // 默认勾选
const isFirstMessage = ref(true)   // 是否尚未发送过首条消息
const sending = ref(false)
const inputText = ref('')

// 消息列表：从 sessionStore 获取该 sideSession 的消息
const messages = computed<ChatMessage[]>(() => {
  return sessionStore.getMessages(String(props.sideSessionId))
})

const canSend = computed(() => inputText.value.trim().length > 0 && !sending.value)

onMounted(() => {
  // 订阅边路任务会话的 WS 事件
  subscribe(String(props.sideSessionId))
})

onUnmounted(() => {
  unsubscribe(String(props.sideSessionId))
})

function handleSend() {
  if (!canSend.value) return
  const content = inputText.value.trim()

  if (isFirstMessage.value) {
    // 首条消息：使用 create_side_session
    send({
      type: 'create_side_session',
      sessionId: Number(sessionStore.activeSessionId),
      data: { content, inheritContext: inheritContext.value }
    })
    isFirstMessage.value = false
    inheritContext.value = false // 后续消息不再需要
  } else {
    // 后续消息：使用标准 send_message
    send({
      type: 'send_message',
      sessionId: props.sideSessionId,
      data: { content, eventId: crypto.randomUUID() }
    })
  }

  sending.value = true
  inputText.value = ''

  // sending 在收到 session_status(COMPLETED/FAILED/CANCELLED) 后重置
}
</script>
```

**说明**：
- `SideChatPanel` 不自己维护消息列表，而是从 `sessionStore` 读取对应 sessionId 的消息
- 流式事件（`content_delta`、`tool_call_start` 等）通过 sessionStore 的 `appendDelta()` / `appendToolCallStart()` 等方法处理——这些方法按 sessionId 操作，边路任务会自动使用 `sideSessionId`
- 消息组件（`MessageBubble`）完全复用

#### C4. CenterTabContainer — 新增 side_task 渲染分支

**文件**：`desktop/src/components/center/CenterTabContainer.vue`

**修改内容**：在 `KeepAlive` 中新增 `side_task` 类型的分支：

```vue
<template>
  <div class="center-tab-container">
    <KeepAlive :max="20">
      <ChatPanel v-if="activeTabId === 'chat'" />
      <FileViewer
        v-else-if="activeTab?.type === 'file'"
        :key="activeTabId"
        :file-path="activeTab.filePath || ''"
        :provider="fileProvider"
      />
      <FileDiffViewer
        v-else-if="activeTab?.type === 'diff' && activeTab.fileChange"
        :key="activeTabId"
        :change="activeTab.fileChange"
      />
      <!-- 新增 -->
      <SideChatPanel
        v-else-if="activeTab?.type === 'side_task' && activeTab.sideSessionId != null"
        :key="activeTabId"
        :side-session-id="activeTab.sideSessionId"
      />
    </KeepAlive>
  </div>
</template>

<script setup lang="ts">
// ... 现有 imports ...
import SideChatPanel from '../chat/SideChatPanel.vue'
// ...
</script>
```

#### C5. TaskView — 集成边路任务入口

**文件**：`desktop/src/views/task/TaskView.vue`

**修改内容**：

1. 在模板中增加「+ 边路任务」按钮（放在 Tab Bar 区域）：

```vue
<!-- 在 CenterTabBar 旁边增加按钮 -->
<div class="tab-bar-actions">
  <el-button size="small" @click="handleNewSideTask" :icon="Plus">
    边路任务
  </el-button>
</div>
```

2. 新增 `handleNewSideTask()` 方法：

```typescript
function handleNewSideTask() {
  // 创建一个占位 Tab（尚未关联真实 sideSessionId）
  // 用户在 Tab 中输入并发送首条消息时，后端才创建 side_session
  const { openSideTaskTab } = useCenterTabs(activeSessionIdRef)
  
  // 使用临时 ID，首条消息发送后更新为真实 sideSessionId
  const tempId = Date.now()
  openSideTaskTab(tempId, '边路任务')
}
```

**更优方案**：直接在 `SideChatPanel` 内部管理 Tab 标题更新。`SideChatPanel` 在收到 `side_session_created` 事件后，调用 `useCenterTabs` 更新对应 Tab 的 `sideSessionId` 和 `title`。
- 创建临时 Tab（`side:temp_xxx`）
- 收到 `side_session_created` 后，更新 Tab 的 `id` 为 `side:真实ID` 并更新 `title`

**简化方案**（推荐）：不创建占位 Tab，而是 `handleNewSideTask()` 直接调用后端创建边路会话（REST API 或 WS），获取 sideSessionId 后再打开 Tab。但这意味着会话创建和首条消息是分开的。

**最终推荐方案**：用户点击「+ 边路任务」→ 前端立即发送 `create_side_session` 请求（content 为空）→ 后端创建空 side_task session → 返回 sideSessionId → 前端打开 Tab → 用户在 Tab 中发送消息（复用 send_message）。

但这样首条消息还需要处理 inheritContext。如果将 inheritContext 存入 side_task session 的 config 字段，`buildContext` 时自动检测并注入摘要，就无需在首条消息时特殊处理。

**最终推荐方案优化**：

1. 点击「+ 边路任务」→ WS `create_side_session`（带 content 和 inheritContext）→ 后端创建 session + 保存 USER + 执行
2. 创建后 Tab 出现，首条消息已在执行
3. 后续消息：WS `send_message`（sessionId = sideSessionId）

这让入口更简洁——点击后直接输入首条消息内容。

调整 `handleNewSideTask()`：

```typescript
function handleNewSideTask() {
  // 弹出输入对话框或直接打开 Tab 让用户输入
  // 简化方案：直接打开 Tab，Tab 中有输入框
  const tempId = 'side:new_' + Date.now()
  openSideTaskTab(0, '边路任务') // sideSessionId 为 0 表示"待创建"
  // SideChatPanel 检测到 sideSessionId 为 0 时显示初始输入界面
}
```

#### C6. sessionStore — 确保边路任务消息独立缓存

**文件**：`desktop/src/stores/session.ts`

**现有能力已够**：`sessionMessages` 是按 sessionId 的 Map，`getMessages(sessionId)` 返回指定会话的消息。边路任务的消息通过 `sideSessionId` 存取，与主会话完全隔离，无需额外修改。

**可能需要微调**：
- `appendDelta()` 方法内部调用 `ensureStreamingAssistantMessage()`，该方法按 `sid` 操作——正确
- `appendToolCallStart()` / `updateToolCallResult()` 同上
- `sessionStreaming` / `sessionThinking` 等 streaming 状态也是按 sessionId 的 Map——自然支持多会话

#### C7. useStreamWS — 确保订阅机制支持边路任务

**文件**：`desktop/src/composables/useStreamWS.ts`

**无需修改**，现有机制已支持：
- `subscribe(sessionId)` / `unsubscribe(sessionId)` — `SideChatPanel` 在 `onMounted` 时订阅 `sideSessionId`
- `routeEvent()` 按传入的 `sessionId` 路由事件——边路任务事件会路由到正确的 session

---

### 模块 D：WebSocket 事件协议

#### D1. 客户端 → 服务端

| type | 说明 | 字段 | 使用场景 |
|------|------|------|---------|
| `create_side_session` | 创建边路任务并发送首条消息 | `sessionId`(parent), `data: { content, inheritContext }` | 首条消息 |
| `send_message` | 边路任务后续消息（复用标准协议） | `sessionId`(side), `data: { content, eventId }` | 后续多轮消息 |
| `cancel_side_task` | 取消边路任务 | `sideSessionId` | 用户取消 |

#### D2. 服务端 → 客户端（新增事件）

| type | 说明 | 字段 |
|------|------|------|
| `side_session_created` | 边路任务会话已创建 | `sessionId`(parent), `data: { sideSessionId, title }` |

**注意**：边路任务的流式事件（`content_delta`、`tool_call_start`、`tool_call_result`、`session_status` 等）复用**标准事件类型**，使用 `sessionId = sideSessionId` 路由。前端通过订阅 sideSessionId 接收这些事件，`routeEvent()` 无需修改。

---

## 6. 落地清单

### 6.1 后端

| # | 任务 | 文件 | 类型 | 依赖 |
|---|------|------|------|------|
| B1 | 数据库迁移脚本 | `V041__add_side_task_support.sql` | 新增 | V040（或合并） |
| B2 | `HarnessService.executeSideFirstMessage()` | `HarnessService.java` | 新增方法 | B1 |
| B3 | `HarnessService.generateContextSummary()` | `HarnessService.java` | 新增方法 | - |
| B4 | `HarnessService.buildContext()` 改为 public | `HarnessService.java` | 修改 | - |
| B5 | `StreamingWsHandler.handleCreateSideSession()` | `StreamingWsHandler.java` | 新增方法 | B2 |
| B6 | `StreamingWsHandler.handleCancelSideTask()` | `StreamingWsHandler.java` | 新增方法 | - |
| B7 | `SessionService.updateField()` | `SessionService.java` | 新增方法 | - |
| B8 | `SessionService.save()` | `SessionService.java` | 新增方法 | - |
| B9 | `saveMessage()` 跳过边路任务标题生成 | `SessionService.java` | 修改 | B1 |

### 6.2 前端

| # | 任务 | 文件 | 类型 | 依赖 |
|---|------|------|------|------|
| F1 | `Tab` 类型扩展（新增 `side_task`） | `desktop/src/types/file-browser.ts` | 修改 | - |
| F2 | `useCenterTabs` 新增 `openSideTaskTab()` / `closeSideTaskTab()` | `desktop/src/composables/useCenterTabs.ts` | 新增方法 | F1 |
| F3 | `SideChatPanel` 组件 | `desktop/src/components/chat/SideChatPanel.vue` | 新增组件 | F2 |
| F4 | `CenterTabContainer` 新增 `side_task` 渲染分支 | `desktop/src/components/center/CenterTabContainer.vue` | 修改 | F3 |
| F5 | `useStreamWS` 新增 `create_side_session` 发送方法 | `desktop/src/composables/useStreamWS.ts` | 新增方法 | - |
| F6 | `useStreamWS` 新增 `side_session_created` 事件处理 | `desktop/src/composables/useStreamWS.ts` | 新增 | - |
| F7 | `TaskView` 新增「+ 边路任务」入口 | `desktop/src/views/task/TaskView.vue` | 修改 | F2 |

### 6.3 建议实现顺序

```
模块 A (数据库) → 模块 B (后端) → 模块 C (前端)

后端：
  B1 → B4 → B2/B3 → B5/B6 → B7/B8/B9

前端（无后端依赖的部分可以先做）：
  F1 → F2 → F5/F6 → F3 → F4 → F7
```

---

## 7. 关键设计决策

| # | 决策 | 理由 |
|---|------|------|
| 1 | 边路任务作为 Tab 管理，复用 `useCenterTabs` | 与文件预览/Diff 对比统一交互范式，不引入新的 UI 模式 |
| 2 | 首条消息用专用 `create_side_session` 事件，后续复用 `send_message` | 首条需要创建会话 + 注入上下文；后续走标准流程最大化复用 |
| 3 | 流式事件使用标准事件类型 + sideSessionId 路由 | 不添加冗余的 `side_*` 事件前缀，前端通过 sessionId 自然隔离 |
| 4 | 边路任务使用独立 session（`session_type = 'side_task'`） | 复用现有 session/message 基础设施，不新增表 |
| 5 | 边路任务结果不写回主会话 | 核心需求：隔离上下文 |
| 6 | 上下文继承仅首条消息生效，通过 system prompt 注入摘要 | 首条消息后的上下文由边路任务自身的历史消息提供 |
| 7 | 复用主任务 Agent/模型/工作区，不可修改 | 简化 UI 和实现 |
| 8 | 边路任务与主任务并行执行 | sessionLock 按 sessionId 隔离，天然并行 |
| 9 | 支持多轮对话 | 用户在边路 Tab 中可追加回复，走标准 send_message 流程 |
| 10 | 关闭 Tab 不删除会话数据 | 用户可以重新打开；数据在 DB 中保留 |

---

## 8. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 边路任务与主任务并发操作同一文件 | 产生文件冲突 | `SideChatPanel` 中给出提示"主任务可能正在操作文件" |
| 边路任务工具调用需审批（LOCAL 模式） | 因等待审批而卡住 | 继承主会话 permissionLevel；审批 UI 需标注来源为边路任务 |
| 边路任务执行中用户再次发送消息 | handleSendMessage 检测到 RUNNING 拒绝 | 复用消息队列机制，busy 时入队等待 |
| 边路任务 session 数据膨胀 | DB 中堆积大量 side_task session | 后续增加清理策略：关闭主会话时级联清理子会话；或定期清理超过 N 天的 side_task |
| KeepAlive 缓存过多 Tab | 内存占用增长 | `KeepAlive :max="20"` 限制已有；边路任务 Tab 数量由用户控制 |
| 边路任务 Tab 内 WS 订阅未取消 | 内存泄漏、多余事件 | `SideChatPanel.onUnmounted()` 调用 unsubscribe |

---

## 9. 不做清单

以下需求明确**不在本方案范围内**：

| 不做的事项 | 原因 |
|-----------|------|
| Agent 通过工具调用发起边路任务 | 用户明确只需"用户手动触发" |
| 边路任务结果注入主任务上下文 | 核心需求要求"不影响主任务上下文" |
| 边路任务允许切换 Agent/模型/工作区 | 简化设计，定位为快捷操作 |
| 管理后台支持边路任务 | 仅桌面端用户场景 |
| 边路任务保存为模板/快捷指令 | 后续可扩展，本方案不做 |
| 边路任务支持图片输入 | 部署/提交等场景不需要图片 |
| 边路任务 Tab 关闭后 session 仍出现在会话列表 | 边路任务仅通过 Tab 访问，`session_type = 'side_task'` 的会话不在主会话列表 API 中返回 |
| 多个边路任务 Tab 间切换保留完整的对话状态 | `KeepAlive` + `sessionStore` 的按 sessionId 缓存已支持 |
