# 子智能体集成技术方案

> 参考 Claude Code 的 Agent 工具架构，为当前项目引入子智能体（Sub-Agent）能力。
>
> 核心思想：主 Agent 通过 `delegate` 工具调用启动子智能体，子智能体复用同一个 `AgentLoop`，但运行在隔离的上下文、消息链和会话中；最终只把压缩后的结果交还给主 Agent。

## 一、设计目标

### 1. 保护主上下文窗口

大量搜索结果、文件内容、日志输出会污染主 Agent 的上下文。子智能体承担这些工作后，主 Agent 只接收最终摘要。

### 2. 并行化独立任务

多个互不依赖的子任务（如多文件搜索、多维度审查）可以并行启动，缩短总执行时间。

### 3. 专家化能力拆分

不同子智能体类型拥有不同的 system prompt、工具集和行为约束：

- `explore`：只读搜索，不能写文件
- `general`：通用委托，拥有全部工具

### 4. 复用 Runtime，隔离状态

不为子智能体另写执行引擎。复用现有 `AgentLoop.execute()`，通过 `AgentExecutionContext` 隔离消息链、工具集、会话 ID。

### 5. 支持前台与后台执行

- 前台：主 Agent 阻塞等待子智能体完成，适合短任务
- 后台：子智能体异步执行，完成后通知主 Agent，适合长任务

## 二、整体架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        主 Agent Loop                            │
│  AgentLoop.execute(parentContext, parentListener)                │
│                                                                 │
│  LLM 输出 → tool_use: { name: "delegate", arguments: {...} }   │
│       │                                                         │
│       ▼                                                         │
│  ToolDispatcher.dispatch("delegate", args, ...)                 │
│       │                                                         │
│       ▼                                                         │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │                   DelegateTool.execute()                 │    │
│  │                                                         │    │
│  │  1. 解析参数: prompt / subagent_type / description      │    │
│  │  2. 选择 AgentDefinition                                │    │
│  │  3. 创建子会话 (session 表)                              │    │
│  │  4. 构建子 AgentExecutionContext                         │    │
│  │     - 隔离的消息链 (从 prompt 开始)                      │    │
│  │     - 过滤后的工具集 (按 definition)                     │    │
│  │     - 独立的 system prompt                               │    │
│  │     - 独立的 sessionId                                   │    │
│  │  5. 启动 AgentLoop.execute(subContext, subListener)      │    │
│  │  6. 收集最终结果 → 返回给主 Agent                        │    │
│  └─────────────────────────────────────────────────────────┘    │
│       │                                                         │
│       ▼                                                         │
│  主 Agent 收到 tool_result (子智能体最终报告)                   │
│  继续主循环...                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### 前台执行时序

```
主 Agent Loop                    DelegateTool              子 Agent Loop
    │                                │                         │
    │── tool_use: delegate ─────────>│                         │
    │                                │── 创建子会话 ──────────>│
    │                                │── AgentLoop.execute() ─>│
    │                                │                         │── LLM 调用
    │                                │                         │── 执行工具
    │                                │                         │── LLM 调用
    │                                │                         │── ...循环...
    │                                │                         │── 完成
    │                                │<── 最终结果 ────────────│
    │<── tool_result ────────────────│                         │
    │  (子智能体最终报告)             │                         │
```

### 后台执行时序

```
主 Agent Loop                    DelegateTool              子 Agent Loop
    │                                │                         │
    │── tool_use: delegate ─────────>│                         │
    │   (run_in_background=true)     │── 创建子会话 ──────────>│
    │                                │── 注册后台任务 ─────────>│
    │                                │── CompletableFuture ───>│
    │<── tool_result ────────────────│  (立即返回任务 ID)       │
    │  "后台任务已启动: xxx"          │                         │── LLM 调用
    │                                │                         │── 执行工具
    │── 继续其他工具调用...           │                         │── ...循环...
    │                                │                         │── 完成
    │                                │                         │
    │   ┌────────────────────────────┼─────────────────────────│
    │   │ 通道 1: 内存队列           │<── backgroundResults ───│
    │   │ (主 loop 下一轮消费)       │                         │
    │   └────────────────────────────┼─────────────────────────│
    │   ┌────────────────────────────┼─────────────────────────│
    │   │ 通道 2: DB + WS 通知       │                         │
    │   │ persistAndNotify():        │                         │
    │   │  - 更新子会话状态 ─────────>│ DB                      │
    │   │  - 写入执行记录表 ─────────>│ DB                      │
    │   │  - 注入 SYSTEM 消息到父会话>│ DB                      │
    │   │  - WS 推送完成通知 ────────>│ 前端                    │
    │   └────────────────────────────┼─────────────────────────│
    │                                │                         │
    │── 下一轮 LLM 调用前 ─────────────────────────────────────>│
    │   通道 1: 注入内存队列结果                                  │
    │   (如果主 loop 已退出，通道 2 的 DB 记录兜底)               │
```

## 三、新增组件

### 1. AgentDefinition — 子智能体类型定义

```java
package com.agentworkbench.harness.subagent;

import lombok.Builder;
import lombok.Data;
import java.util.List;
import java.util.Set;

/**
 * 子智能体类型定义。每种类型有不同的 prompt、工具集和行为约束。
 */
@Data
@Builder
public class AgentDefinition {

    /** 类型标识，如 "explore", "general" */
    private String agentType;

    /** 何时使用此类型的描述，注入到主 Agent 的 system prompt 中 */
    private String whenToUse;

    /** 工具白名单，null 或 ["*"] 表示使用全部工具 */
    private List<String> tools;

    /** 工具黑名单，优先级高于白名单 */
    private Set<String> disallowedTools;

    /** 默认最大轮次 */
    @Builder.Default
    private int defaultMaxRounds = 15;

    /** 是否默认后台运行 */
    @Builder.Default
    private boolean defaultBackground = false;

    /** 权限级别覆盖，null 时继承主会话 */
    private String permissionLevel;

    /** system prompt 模板，支持 {workspace}, {task_description} 占位符 */
    private String systemPromptTemplate;
}
```

### 2. AgentDefinitionRegistry — 子智能体类型注册中心

```java
package com.agentworkbench.harness.subagent;

import org.springframework.stereotype.Component;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 管理所有子智能体类型定义。
 * 启动时注册内置类型，运行时可动态扩展。
 */
@Component
public class AgentDefinitionRegistry {

    private final Map<String, AgentDefinition> definitions = new ConcurrentHashMap<>();

    public AgentDefinitionRegistry() {
        registerBuiltinDefinitions();
    }

    public AgentDefinition getDefinition(String agentType) {
        return definitions.get(agentType);
    }

    public List<AgentDefinition> getAllDefinitions() {
        return List.copyOf(definitions.values());
    }

    public void register(AgentDefinition definition) {
        definitions.put(definition.getAgentType(), definition);
    }

    private void registerBuiltinDefinitions() {
        // --- explore: 只读搜索 ---
        register(AgentDefinition.builder()
                .agentType("explore")
                .whenToUse("用于搜索文件、查找关键词、了解代码库结构。"
                        + "适合快速定位代码、理解项目布局。")
                .tools(List.of("read_file", "glob_search", "grep_search"))
                .defaultMaxRounds(10)
                .systemPromptTemplate(EXPLORE_PROMPT)
                .build());

        // --- general: 通用委托 ---
        register(AgentDefinition.builder()
                .agentType("general")
                .whenToUse("用于执行独立的子任务，如实现一个函数、修复一个 bug。"
                        + "拥有全部工具，可以读写文件和运行命令。")
                .tools(List.of("*"))
                .defaultMaxRounds(20)
                .systemPromptTemplate(GENERAL_PROMPT)
                .build());
    }

    // --- Prompt 模板 ---

    private static final String EXPLORE_PROMPT = """
            你是一个代码搜索专家。你的任务是快速、准确地搜索代码库并报告结果。

            规则：
            - 只读操作，禁止创建、修改或删除任何文件
            - 使用 glob_search 定位文件，grep_search 搜索内容，read_file 查看详情
            - 尽量并行使用搜索工具提高效率
            - 清晰报告找到的文件路径、行号和相关内容

            工作目录：{workspace}
            """;

    private static final String GENERAL_PROMPT = """
            你是一个专业的 AI 助手，负责执行分配给你的子任务。

            规则：
            - 专注于完成分配的任务，不要偏离主题
            - 完成后给出清晰的结果报告
            - 如果遇到无法解决的问题，明确说明

            工作目录：{workspace}
            """;
}
```

### 3. DelegateTool — 子智能体调用工具

这是主 Agent 可以调用的工具，实现 `Tool` 接口。

```java
package com.agentworkbench.harness.subagent;

import com.agentworkbench.harness.core.*;
import com.agentworkbench.harness.llm.ChatRequest;
import com.agentworkbench.harness.llm.LlmModelConfig;
import com.agentworkbench.harness.tool.Tool;
import com.agentworkbench.harness.tool.ToolRegistry;
import com.agentworkbench.model.entity.LlmModel;
import com.agentworkbench.model.mapper.LlmModelMapper;
import com.agentworkbench.session.entity.Session;
import com.agentworkbench.session.mapper.SessionMapper;
import com.agentworkbench.session.service.SessionService;
import com.agentworkbench.session.ws.StreamingWsRegistry;
import com.agentworkbench.session.ws.WsEvent;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.context.annotation.Lazy;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.concurrent.*;

/**
 * 子智能体调用工具。主 Agent 通过调用此工具委托子任务。
 */
@Slf4j
@Component
public class DelegateTool implements Tool {

    private final AgentDefinitionRegistry definitionRegistry;
    private final AgentLoop agentLoop;
    private final ToolRegistry toolRegistry;
    private final SessionMapper sessionMapper;
    private final SessionService sessionService;
    private final HarnessService harnessService;         // 复用 buildContext()
    private final StreamingWsRegistry streamingWsRegistry; // WS 通知
    private final ObjectMapper objectMapper;
    private final ExecutorService backgroundExecutor = Executors.newCachedThreadPool();

    // 后台任务结果暂存：taskId -> result JSON
    private final ConcurrentHashMap<String, String> backgroundResults = new ConcurrentHashMap<>();

    public DelegateTool(AgentDefinitionRegistry definitionRegistry,
                        AgentLoop agentLoop,
                        ToolRegistry toolRegistry,
                        SessionMapper sessionMapper,
                        SessionService sessionService,
                        HarnessService harnessService,
                        StreamingWsRegistry streamingWsRegistry,
                        ObjectMapper objectMapper) {
        this.definitionRegistry = definitionRegistry;
        this.agentLoop = agentLoop;
        this.toolRegistry = toolRegistry;
        this.sessionMapper = sessionMapper;
        this.sessionService = sessionService;
        this.harnessService = harnessService;
        this.streamingWsRegistry = streamingWsRegistry;
        this.objectMapper = objectMapper;
    }

    @Override
    public String getName() {
        return "delegate";
    }

    @Override
    public String getDescription() {
        return "将子任务委托给专门的子智能体执行。"
                + "子智能体拥有独立的上下文和工具集，完成后返回结果摘要。";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        return Map.of(
                "type", "object",
                "properties", Map.of(
                        "prompt", Map.of(
                                "type", "string",
                                "description", "子任务的详细描述，包含背景、目标和期望输出"),
                        "subagent_type", Map.of(
                                "type", "string",
                                "enum", List.of("explore", "general"),
                                "description", "子智能体类型"),
                        "description", Map.of(
                                "type", "string",
                                "description", "任务的简短描述，用于 UI 显示"),
                        "run_in_background", Map.of(
                                "type", "boolean",
                                "description", "是否后台运行，默认 false")
                ),
                "required", List.of("prompt", "subagent_type")
        );
    }

    @Override
    public String execute(String arguments, Long sessionId, String workspace) {
        try {
            Map<String, Object> args = objectMapper.readValue(arguments, Map.class);
            String prompt = (String) args.get("prompt");
            String subagentType = (String) args.get("subagent_type");
            String description = (String) args.getOrDefault("description", "子任务");
            boolean runInBackground = Boolean.TRUE.equals(args.get("run_in_background"));

            // 1. 查找 agent definition
            AgentDefinition definition = definitionRegistry.getDefinition(subagentType);
            if (definition == null) {
                return errorJson("未知的子智能体类型: " + subagentType);
            }

            // 2. 获取父会话信息
            Session parentSession = sessionMapper.selectById(sessionId);
            if (parentSession == null) {
                return errorJson("父会话不存在: " + sessionId);
            }

            // 3. 创建子会话
            Session childSession = createChildSession(parentSession, definition, description);

            // 4. 写入初始 user message 到子会话（buildContext 会从 DB 加载）
            sessionService.saveMessage(childSession.getId(), "USER", prompt,
                    null, null, null, 0, null);

            // 5. 构建子 AgentExecutionContext（复用 HarnessService.buildContext）
            AgentExecutionContext subContext = buildSubContext(
                    childSession, parentSession, definition, prompt, childSession.getId());

            // 6. 执行
            if (runInBackground) {
                return executeInBackground(childSession.getId(), sessionId, subContext, parentSession.getUserId());
            } else {
                return executeInForeground(subContext, childSession.getId());
            }

        } catch (Exception e) {
            log.error("DelegateTool execution failed", e);
            return errorJson("子智能体执行失败: " + e.getMessage());
        }
    }

    /**
     * 前台执行：阻塞等待子智能体完成，返回最终结果。
     *
     * 注意：此方法在 AgentLoop.executeToolCalls() 的线程中同步执行，
     * 主 Agent 会阻塞等待子智能体完成后才能继续。
     */
    private String executeInForeground(AgentExecutionContext subContext, Long childSessionId) {
        SubAgentResultCollector collector = new SubAgentResultCollector();

        try {
            // 前台执行，使用持久化回调将子会话消息写入 DB
            agentLoop.execute(subContext, collector,
                    createSubPersistenceCallback(childSessionId, subContext));

            // 提取最终结果
            return buildResultJson(childSessionId, collector);
        } catch (Exception e) {
            log.error("Sub-agent foreground execution failed", e);
            return errorJson("子智能体执行失败: " + e.getMessage());
        }
    }

    /**
     * 后台执行：异步启动，立即返回任务 ID。
     *
     * 完成后的结果送达采用双通道策略：
     * 1. 内存队列：主 Agent loop 仍在运行时，在每轮 LLM 调用前通过 consumeBackgroundResults() 注入
     * 2. DB + WS 通知：主 Agent loop 已退出时，结果写入父会话 + WebSocket 推送前端通知
     */
    private String executeInBackground(Long childSessionId,
                                        Long parentSessionId,
                                        AgentExecutionContext subContext,
                                        Long userId) {
        String taskId = UUID.randomUUID().toString().substring(0, 8);

        backgroundExecutor.submit(() -> {
            SubAgentResultCollector collector = new SubAgentResultCollector();
            long startTime = System.currentTimeMillis();
            try {
                agentLoop.execute(subContext, collector,
                        createSubPersistenceCallback(childSessionId, subContext));

                String result = buildResultJson(childSessionId, collector);
                long elapsed = System.currentTimeMillis() - startTime;

                // 通道 1：放入内存队列（主 loop 活跃时消费）
                backgroundResults.put(taskId, result);

                // 通道 2：持久化到 DB + WS 通知（主 loop 已退出时送达）
                persistAndNotify(taskId, parentSessionId, childSessionId,
                        collector, result, elapsed, true, null);

                log.info("Background sub-agent {} completed for session {}", taskId, childSessionId);
            } catch (Exception e) {
                log.error("Background sub-agent {} failed", taskId, e);
                String errorResult = errorJson("后台子智能体执行失败: " + e.getMessage());
                backgroundResults.put(taskId, errorResult);

                persistAndNotify(taskId, parentSessionId, childSessionId,
                        collector, errorResult, System.currentTimeMillis() - startTime,
                        false, e.getMessage());
            }
        });

        Map<String, Object> response = new LinkedHashMap<>();
        response.put("status", "started");
        response.put("task_id", taskId);
        response.put("child_session_id", childSessionId);
        response.put("message", "后台任务已启动，完成后结果将自动注入上下文");
        return toJson(response);
    }

    /**
     * 获取已完成的后台任务结果（由 AgentLoop 在每轮开始前调用）。
     * 对应结果送达通道 1：主 loop 活跃期间的内存消费。
     */
    public Map<String, String> consumeBackgroundResults() {
        Map<String, String> results = new LinkedHashMap<>(backgroundResults);
        backgroundResults.clear();
        return results;
    }

    /**
     * 结果送达通道 2：持久化到 DB + WebSocket 通知。
     *
     * 无论主 loop 是否仍在运行，都会执行此方法。
     * 主 loop 活跃时：consumeBackgroundResults() 会先消费内存队列，
     *   DB 记录和 WS 通知作为兜底（防止 loop 退出后结果丢失）。
     * 主 loop 已退出时：DB 记录是主要载体，WS 通知触发前端更新。
     */
    private void persistAndNotify(String taskId, Long parentSessionId, Long childSessionId,
                                   SubAgentResultCollector collector, String resultJson,
                                   long elapsed, boolean success, String errorMessage) {
        // 1. 更新子会话状态
        try {
            Session childSession = sessionMapper.selectById(childSessionId);
            if (childSession != null) {
                childSession.setStatus(success ? "COMPLETED" : "FAILED");
                sessionMapper.updateById(childSession);
            }
        } catch (Exception e) {
            log.warn("Failed to update child session status", e);
        }

        // 2. 写入子智能体执行记录表
        try {
            // INSERT INTO subagent_execution (parent_session_id, child_session_id, ...)
            // 使用 SubagentExecutionMapper
            subagentExecutionMapper.insert(SubagentExecution.builder()
                    .parentSessionId(parentSessionId)
                    .childSessionId(childSessionId)
                    .subagentType(collector.getSubagentType())
                    .status(success ? "COMPLETED" : "FAILED")
                    .isBackground(true)
                    .totalRounds(collector.getTotalRounds())
                    .totalTokens(collector.getTotalTokens())
                    .resultSummary(truncate(collector.getFinalContent(), 2000))
                    .errorMessage(errorMessage)
                    .elapsedMs(elapsed)
                    .completedAt(LocalDateTime.now())
                    .build());
        } catch (Exception e) {
            log.warn("Failed to persist subagent_execution record", e);
        }

        // 3. 将结果注入父会话（作为 SYSTEM 消息），供下一轮对话使用
        try {
            String systemContent = buildParentInjectionMessage(taskId, childSessionId, collector, success);
            sessionService.saveMessage(parentSessionId, "SYSTEM", systemContent,
                    null, null, null, 0, null);
        } catch (Exception e) {
            log.warn("Failed to inject sub-agent result into parent session", e);
        }

        // 4. WebSocket 通知前端
        try {
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("task_id", taskId);
            data.put("child_session_id", childSessionId);
            data.put("status", success ? "completed" : "failed");
            data.put("total_tokens", collector.getTotalTokens());
            data.put("elapsed_ms", elapsed);
            if (!success) {
                data.put("error", errorMessage);
            }
            streamingWsRegistry.send(userId, WsEvent.of(
                    "subagent_background_completed", parentSessionId, data));
        } catch (Exception e) {
            log.warn("Failed to send WS notification for sub-agent completion", e);
        }
    }

    /**
     * 构建注入父会话的系统消息内容。
     * 主 Agent 在下一轮对话时会从 DB 加载到这条消息，自然感知结果。
     */
    private String buildParentInjectionMessage(String taskId, Long childSessionId,
                                                SubAgentResultCollector collector, boolean success) {
        StringBuilder sb = new StringBuilder();
        sb.append("<子智能体后台任务完成>\n");
        sb.append("任务 ID：").append(taskId).append("\n");
        sb.append("子会话 ID：").append(childSessionId).append("\n");
        sb.append("状态：").append(success ? "成功" : "失败").append("\n");
        sb.append("消耗 token：").append(collector.getTotalTokens()).append("\n");
        sb.append("执行轮次：").append(collector.getTotalRounds()).append("\n\n");
        sb.append("结果：\n").append(collector.getFinalContent());
        sb.append("\n</子智能体后台任务完成>");
        return sb.toString();
    }

    // --- 内部方法 ---

    private Session createChildSession(Session parent, AgentDefinition definition, String description) {
        Session child = new Session();
        child.setUserId(parent.getUserId());
        child.setAgentId(parent.getAgentId());
        child.setTitle("[" + definition.getAgentType() + "] " + description);
        // 执行模式和工作区与父会话保持一致
        child.setExecutionMode(parent.getExecutionMode());
        child.setWorkspace(parent.getWorkspace());
        child.setPermissionLevel(
                definition.getPermissionLevel() != null
                        ? definition.getPermissionLevel()
                        : parent.getPermissionLevel());
        child.setModelId(parent.getModelId());
        child.setIsGit(parent.getIsGit());
        child.setPlatform(parent.getPlatform());
        child.setShellPath(parent.getShellPath());
        child.setOsVersion(parent.getOsVersion());
        child.setStatus("ACTIVE");
        child.setPhase(null); // 子会话不使用 phase 跟踪，只用 status
        // 存储父子关系
        child.setParentSessionId(parent.getId());
        child.setSessionType("subagent");
        sessionMapper.insert(child);
        return child;
    }

    /**
     * 构建子智能体的执行上下文。
     *
     * 复用 HarnessService.buildContext() 获取基础上下文（含环境信息、模型配置等），
     * 然后覆盖 system prompt 和工具集。
     *
     * 前置条件：子会话已创建并持久化，HarnessService.buildContext() 已改为 public。
     */
    private AgentExecutionContext buildSubContext(Session childSession,
                                                  Session parentSession,
                                                  AgentDefinition definition,
                                                  String prompt,
                                                  Long childSessionId) {
        // 1. 先将子智能体的 system prompt 写入子会话关联的 agent 记录，
        //    或直接覆盖 context.systemPrompt（见下方第 3 步）

        // 2. 复用 HarnessService 构建基础上下文
        //    自动包含：session 信息、模型配置、环境信息（platform/shell/os）
        AgentExecutionContext ctx = harnessService.buildContext(childSessionId);

        // 3. 覆盖 system prompt 为子智能体专用模板
        //    PromptEngine.buildRequest() 会以 ctx.systemPrompt 为基础，
        //    自动追加环境信息、工具提示等，无需手动注入
        String systemPrompt = definition.getSystemPromptTemplate()
                .replace("{workspace}", childSession.getWorkspace() != null
                        ? childSession.getWorkspace() : "未指定");
        ctx.setSystemPrompt(systemPrompt);

        // 4. 覆盖 maxRounds
        ctx.setMaxRounds(definition.getDefaultMaxRounds());

        // 5. 设置子智能体名称
        ctx.setAgentName(definition.getAgentType() + "-agent");

        // 6. 清除消息历史（buildContext 会从 DB 加载，子会话此时只有我们刚写入的 user message）
        //    重新设置初始消息
        ctx.getMessages().clear();
        ctx.addUserMessage(prompt);

        // 7. 过滤工具集（覆盖 buildContext 设置的全量工具）
        ctx.setTools(resolveTools(definition));

        // 8. 清除 skills（子智能体不需要技能目录，节省 token）
        ctx.setAvailableSkillNames(null);
        ctx.setAvailableSkillDocs(null);

        return ctx;
    }

    private List<com.agentworkbench.harness.tool.Tool> resolveTools(AgentDefinition definition) {
        List<String> allowed = definition.getTools();
        Set<String> disallowed = definition.getDisallowedTools();

        if (allowed != null && allowed.size() == 1 && "*".equals(allowed.get(0))) {
            allowed = null; // 全部工具
        }

        List<com.agentworkbench.harness.tool.Tool> tools;
        if (allowed != null) {
            tools = toolRegistry.getToolsByNames(allowed);
        } else {
            tools = toolRegistry.getAllTools();
        }

        // 不允许子智能体调用 delegate（禁止无限递归）
        tools = tools.stream()
                .filter(t -> !"delegate".equals(t.getName()))
                .filter(t -> disallowed == null || !disallowed.contains(t.getName()))
                .toList();

        return tools;
    }

    /**
     * 从父会话继承模型配置。
     * 优先使用父 session 的 modelId，回退到系统默认模型。
     */
    private LlmModelConfig resolveModelConfig(Session parentSession) {
        LlmModel llmModel = harnessService.resolveModel(parentSession.getModelId());
        if (llmModel == null) {
            throw new BusinessException(ErrorCode.MODEL_NOT_FOUND);
        }
        return LlmModelConfig.builder()
                .id(llmModel.getId())
                .name(llmModel.getName())
                .provider(llmModel.getProvider())
                .baseUrl(llmModel.getBaseUrl())
                .apiKey(llmModel.getApiKey())
                .modelId(llmModel.getModelId())
                .contextWindowTokens(llmModel.getContextWindowTokens())
                .build();
    }

    private AgentLoop.MessagePersistenceCallback createSubPersistenceCallback(
            Long childSessionId, AgentExecutionContext subContext) {
        return new AgentLoop.MessagePersistenceCallback() {
            @Override
            public void onSaveAssistantMessage(String content, String thinkingContent,
                                                List<ChatRequest.ToolCall> toolCalls,
                                                ChatUsage usage) {
                String toolCallsJson = null;
                if (toolCalls != null && !toolCalls.isEmpty()) {
                    try {
                        toolCallsJson = objectMapper.writeValueAsString(toolCalls);
                    } catch (Exception e) { /* ignore */ }
                }
                int tokenCount = usage != null ? usage.getTotalTokens() : 0;
                Long modelId = subContext.getModelConfig() != null
                        ? subContext.getModelConfig().getId() : null;
                sessionService.saveMessage(childSessionId, "ASSISTANT",
                        content, thinkingContent, null, toolCallsJson, tokenCount, modelId);
            }

            @Override
            public void onSaveToolMessage(String toolCallId, String content) {
                sessionService.saveMessage(childSessionId, "TOOL",
                        content, null, toolCallId, null, 0, null);
            }
        };
    }

    private String buildResultJson(Long childSessionId, SubAgentResultCollector collector) {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("child_session_id", childSessionId);
        result.put("content", collector.getFinalContent());
        result.put("total_rounds", collector.getTotalRounds());
        result.put("total_tokens", collector.getTotalTokens());
        return toJson(result);
    }

    private String errorJson(String message) {
        return "{\"error\": \"" + message.replace("\"", "\\\"") + "\"}";
    }

    private String toJson(Object obj) {
        try {
            return objectMapper.writeValueAsString(obj);
        } catch (Exception e) {
            return "{\"error\": \"JSON serialization failed\"}";
        }
    }
}
```

### 4. SubAgentResultCollector — 结果收集器

```java
package com.agentworkbench.harness.subagent;

import com.agentworkbench.harness.core.AgentEventListener;
import com.agentworkbench.harness.llm.ChatRequest;
import com.agentworkbench.harness.llm.ChatUsage;
import lombok.Getter;

/**
 * 子智能体事件监听器，负责收集最终结果。
 * 只保留最后一个 assistant 消息的文本内容，丢弃中间过程。
 */
@Getter
public class SubAgentResultCollector implements AgentEventListener {

    /** 最终 assistant 文本内容 */
    private String finalContent = "";

    /** 执行总轮次 */
    private int totalRounds = 0;

    /** 总 token 消耗 */
    private int totalTokens = 0;

    /** 最后一次 message_end 的 usage */
    private ChatUsage lastUsage;

    @Override
    public void onContentDelta(String delta) {
        // 每次 content delta 都追加，最终 onMessageEnd 时会截取最后一个 assistant 的内容
        finalContent += delta;
    }

    @Override
    public void onMessageEnd(ChatUsage usage) {
        totalRounds++;
        if (usage != null) {
            lastUsage = usage;
            totalTokens = usage.getTotalTokens();
        }
        // 注意：如果有多个 assistant 消息（多轮 tool call），
        // finalContent 会包含所有轮次的文本。
        // 更精确的做法是每轮开始时重置 finalContent，
        // 只保留最后一轮（无 tool call 的那轮）的文本。
    }

    /**
     * 每轮 LLM 调用开始时重置内容，只保留最后一轮的输出。
     * 在 AgentLoop 的 onThinkingStart 时调用。
     */
    public void onRoundStart() {
        finalContent = "";
    }

    @Override
    public void onToolCallStart(ChatRequest.ToolCall toolCall) {
        // 子智能体内部工具调用，不转发给主 Agent
    }

    @Override
    public void onToolCallResult(String toolCallId, String result) {
        // 子智能体内部工具结果，不转发给主 Agent
    }

    @Override
    public void onError(Throwable t) {
        finalContent = "子智能体执行出错: " + t.getMessage();
    }

    @Override
    public void onContextWindow(int estimatedTokens, int actualTokens) {
        // 忽略
    }

    @Override
    public void onCompactionStart(String type, int messageCount, int estimatedTokens) {
        // 忽略
    }

    @Override
    public void onCompactionEnd(String type, int compactedCount, int savedTokens) {
        // 忽略
    }

    @Override
    public void onThinkingStart() {
        // 每轮开始时重置，确保只保留最后一轮
        onRoundStart();
    }

    @Override
    public void onThinkingDelta(String delta) {
        // 忽略 thinking 内容
    }

    @Override
    public void onThinkingEnd() {
        // 忽略
    }

    @Override
    public void onToolCallArgsDelta(String toolCallId, String arguments) {
        // 忽略
    }
}
```

### 5. ForwardingEventListener — 前台事件转发器（可选）

当需要在前端实时显示子智能体的执行过程时使用。

```java
package com.agentworkbench.harness.subagent;

import com.agentworkbench.harness.core.AgentEventListener;
import com.agentworkbench.harness.llm.ChatRequest;
import com.agentworkbench.harness.llm.ChatUsage;
import com.agentworkbench.session.ws.StreamingWsRegistry;
import com.agentworkbench.session.ws.WsEvent;
import lombok.Getter;

import java.util.Map;

/**
 * 前台子智能体事件转发器。
 * 将子智能体的流式事件转发到父会话的 WebSocket 连接，
 * 前端可以通过 childSessionId 区分来源。
 */
@Getter
public class ForwardingEventListener implements AgentEventListener {

    private final StreamingWsRegistry wsRegistry;
    private final Long parentUserId;
    private final Long childSessionId;
    private final SubAgentResultCollector resultCollector;

    public ForwardingEventListener(StreamingWsRegistry wsRegistry,
                                    Long parentUserId,
                                    Long childSessionId) {
        this.wsRegistry = wsRegistry;
        this.parentUserId = parentUserId;
        this.childSessionId = childSessionId;
        this.resultCollector = new SubAgentResultCollector();
    }

    @Override
    public void onContentDelta(String delta) {
        resultCollector.onContentDelta(delta);
        // 转发到父会话，前端可用 childSessionId 区分来源
        wsRegistry.send(parentUserId, WsEvent.of(
                "subagent_content_delta", childSessionId,
                Map.of("delta", delta)));
    }

    @Override
    public void onToolCallStart(ChatRequest.ToolCall toolCall) {
        resultCollector.onToolCallStart(toolCall);
        wsRegistry.send(parentUserId, WsEvent.of(
                "subagent_tool_call_start", childSessionId,
                Map.of("tool_name", toolCall.getFunction().getName(),
                        "tool_call_id", toolCall.getId())));
    }

    @Override
    public void onToolCallResult(String toolCallId, String result) {
        resultCollector.onToolCallResult(toolCallId, result);
        // 工具结果可能很大，只转发摘要
        String summary = result.length() > 200
                ? result.substring(0, 200) + "..." : result;
        wsRegistry.send(parentUserId, WsEvent.of(
                "subagent_tool_call_result", childSessionId,
                Map.of("tool_call_id", toolCallId, "summary", summary)));
    }

    @Override
    public void onMessageEnd(ChatUsage usage) {
        resultCollector.onMessageEnd(usage);
    }

    @Override
    public void onError(Throwable t) {
        resultCollector.onError(t);
        wsRegistry.send(parentUserId, WsEvent.of(
                "subagent_error", childSessionId,
                Map.of("error", t.getMessage())));
    }

    @Override
    public void onContextWindow(int estimatedTokens, int actualTokens) {
        // 忽略
    }

    @Override
    public void onCompactionStart(String type, int messageCount, int estimatedTokens) {
        // 忽略
    }

    @Override
    public void onCompactionEnd(String type, int compactedCount, int savedTokens) {
        // 忽略
    }

    @Override
    public void onThinkingStart() {
        resultCollector.onThinkingStart();
    }

    @Override
    public void onThinkingDelta(String delta) {
        // 忽略
    }

    @Override
    public void onThinkingEnd() {
        resultCollector.onThinkingEnd();
    }

    @Override
    public void onToolCallArgsDelta(String toolCallId, String arguments) {
        // 忽略
    }
}
```

## 四、数据库变更

### 新增迁移脚本 V040

```sql
-- V040__add_subagent_support.sql

-- 1. session 表增加父子关系字段
ALTER TABLE `session`
    ADD COLUMN `parent_session_id` BIGINT DEFAULT NULL COMMENT '父会话 ID，子智能体使用'
        AFTER `agent_id`,
    ADD COLUMN `session_type` VARCHAR(20) DEFAULT 'main' COMMENT '会话类型: main/subagent'
        AFTER `parent_session_id`;

-- 添加索引
CREATE INDEX idx_session_parent ON `session`(`parent_session_id`);

-- 子会话不使用 phase 字段，允许 NULL
ALTER TABLE `session`
    MODIFY COLUMN `phase` VARCHAR(20) DEFAULT NULL COMMENT '任务阶段，子智能体会话不使用';

-- 2. message 表增加子智能体来源标记
ALTER TABLE `message`
    ADD COLUMN `source_session_id` BIGINT DEFAULT NULL COMMENT '消息来源会话 ID，子智能体结果注入时使用'
        AFTER `session_id`;

CREATE INDEX idx_message_source ON `message`(`source_session_id`);

-- 3. 新增子智能体执行记录表（可选，用于审计和分析）
CREATE TABLE IF NOT EXISTS `subagent_execution` (
    `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
    `parent_session_id` BIGINT NOT NULL COMMENT '父会话 ID',
    `child_session_id` BIGINT NOT NULL COMMENT '子会话 ID',
    `subagent_type` VARCHAR(50) NOT NULL COMMENT '子智能体类型',
    `description` VARCHAR(500) COMMENT '任务描述',
    `status` VARCHAR(20) NOT NULL DEFAULT 'RUNNING' COMMENT '状态: RUNNING/COMPLETED/FAILED/CANCELLED',
    `is_background` TINYINT(1) DEFAULT 0 COMMENT '是否后台运行',
    `total_rounds` INT DEFAULT 0 COMMENT '执行轮次',
    `total_tokens` INT DEFAULT 0 COMMENT '总 token 消耗',
    `result_summary` TEXT COMMENT '结果摘要',
    `error_message` TEXT COMMENT '错误信息',
    `started_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `completed_at` DATETIME,
    `elapsed_ms` BIGINT DEFAULT 0 COMMENT '执行耗时(毫秒)',
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_sae_parent (`parent_session_id`),
    INDEX idx_sae_child (`child_session_id`),
    INDEX idx_sae_status (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='子智能体执行记录';
```

### Session 实体变更

```java
// Session.java 新增字段
private Long parentSessionId;
private String sessionType; // "main" | "subagent"
```

## 五、现有组件改造（前置条件）

### 1. HarnessService — buildContext() 公开化

**现状**: `buildContext(Long sessionId)` 是 `private` 方法。
**改造**: 改为 `public`，供 DelegateTool 复用。

```java
// HarnessService.java
// 改 private → public
public AgentExecutionContext buildContext(Long sessionId) {
    // ... 现有逻辑不变
}
```

同时将 `resolveModel()` 方法也改为 `public`（或 package-private），供 DelegateTool 的 `resolveModelConfig()` 使用。

### 2. AgentLoop — 新增 DelegateTool 依赖

AgentLoop 需要注入 DelegateTool 以在每轮开始前消费后台子智能体结果。注意：存在循环依赖风险（AgentLoop ← DelegateTool → AgentLoop），需通过 `@Lazy` 注解解决。

```java
// AgentLoop.java — 构造函数新增依赖
private final DelegateTool delegateTool; // @Lazy 注入

public AgentLoop(LlmAdapter llmAdapter,
                 PromptEngine promptEngine,
                 ContextManager contextManager,
                 ToolDispatcher toolDispatcher,
                 BackgroundTaskManager backgroundTaskManager,
                 ShellSessionManager shellSessionManager,
                 @Qualifier("toolExecutor") ExecutorService toolExecutor,
                 @Lazy DelegateTool delegateTool) {  // 新增
    // ...
    this.delegateTool = delegateTool;
}
```

### 3. PromptEngine — 无需修改

子智能体的 `AgentExecutionContext.systemPrompt` 设为 `AgentDefinition.systemPromptTemplate`（替换占位符后）。`PromptEngine.buildRequest()` 会以 `context.getSystemPrompt()` 为基础，自动追加环境信息（platform/shell/os）、工具提示等。**无需额外修改 PromptEngine**。

### 4. SessionService.saveMessage() — 跳过子会话标题生成

**现状**: `saveMessage()` 内部会从第一条 user message 自动生成 session title。
**问题**: 子智能体的第一条 user message 会覆盖已设好的 title（如 "[explore] 搜索认证相关代码"）。
**改造**: 在 `saveMessage()` 中判断 `session.sessionType`，如果是 `"subagent"` 则跳过标题生成。

```java
// SessionService.saveMessage() 中
if ("subagent".equals(session.getSessionType())) {
    // 跳过标题自动生成
} else {
    // 现有标题生成逻辑
}
```

### 5. V040 迁移 — phase 字段允许 NULL

子会话不使用 phase 字段跟踪状态。需确认 phase 列允许 NULL，或在迁移脚本中显式设置。

```sql
-- V040 迁移中，session 表变更补充
ALTER TABLE `session`
    MODIFY COLUMN `phase` VARCHAR(20) DEFAULT NULL COMMENT '任务阶段，子智能体会话不使用';
```

---

## 六、AgentLoop 改造

### 1. 注入后台任务结果（通道 1：loop 内消费）

在 `AgentLoop.execute()` 的每轮开始前，除了注入 `BackgroundTaskManager` 的结果，还要注入 `DelegateTool` 的后台子智能体结果。

```java
// AgentLoop.java 改造点

// 新增依赖
private final DelegateTool delegateTool;

// execute() 方法中，在 "0.5. Inject completed background task results" 之后：
// 0.6. Inject completed sub-agent results
Map<String, String> subAgentResults = delegateTool.consumeBackgroundResults();
if (!subAgentResults.isEmpty()) {
    StringBuilder sb = new StringBuilder("<子智能体后台任务结果>\n");
    subAgentResults.forEach((taskId, result) ->
            sb.append("任务 ").append(taskId).append("：\n").append(result).append("\n"));
    sb.append("</子智能体后台任务结果>");
    context.addSystemMessage(sb.toString());
    log.info("Injected {} sub-agent background results", subAgentResults.size());
}
```

### 2. 结果送达的双通道策略

后台子智能体的结果送达存在一个时序问题：主 Agent loop 可能已经退出，`consumeBackgroundResults()` 没有机会被调用。

采用 **内存队列 + DB 持久化** 双通道策略解决：

```
后台子智能体完成
    │
    ├──→ 通道 1：内存队列 (backgroundResults)
    │    主 loop 活跃时 → 下一轮 LLM 调用前注入
    │    主 loop 已退出 → 无人消费（通道 2 兜底）
    │
    └──→ 通道 2：DB + WS 通知 (persistAndNotify)
         写入父会话 SYSTEM 消息 → 主 Agent 下次对话自然加载
         写入 subagent_execution 表 → 审计记录
         WS 推送 subagent_background_completed → 前端即时通知
```

**通道 1 适用场景**：主 Agent 还在执行其他工具调用，后台子智能体先完成，下一轮注入结果。

**通道 2 适用场景**：主 Agent 已经回复用户完毕（loop 退出），后台子智能体才完成。结果通过 DB 持久化，用户下次发消息时主 Agent 从 DB 加载上下文自然看到；同时 WS 通知前端显示完成提示。

**两条通道互不冲突**：通道 1 是内存中的即时消费，通道 2 是 DB 的持久化兜底。即使通道 1 已经消费过，通道 2 的 DB 记录也不影响——主 Agent 加载历史消息时会跳过 SYSTEM 消息中的重复内容（通过 `subagent_execution` 表的 `task_id` 去重）。

**通道 2 的 DB 加载路径确认**：当主 loop 已退出、用户下次发消息时，`HarnessService.buildContext()` 的第 5 步会从 DB 加载消息历史，SYSTEM 消息（含子智能体结果）会被自然加载到上下文中。主 Agent 在下一轮对话时自动感知结果，无需额外注入逻辑。

### 2. DelegateTool 防递归

`DelegateTool` 的 `resolveTools()` 方法已经过滤掉了 `delegate` 工具本身，防止子智能体再调用子智能体形成无限递归。

如果未来需要支持多层嵌套，可以增加深度限制：

```java
// 可选的深度控制
private static final int MAX_DELEGATE_DEPTH = 2;

// 在 buildSubContext 中，如果深度 >= MAX_DELEGATE_DEPTH，
// 从工具集中移除 delegate
```

## 七、工具注册与路由

### ToolDispatcher 路由

`DelegateTool` 作为一个普通的 `Tool` bean，会被 `ToolRegistry` 自动发现和注册。`ToolDispatcher` 的现有路由逻辑无需修改——在 CLOUD 模式下，`delegate` 工具会被路由到 `ToolRegistry` 中的 `DelegateTool` 实例。

在 LOCAL 模式下，`delegate` 应该始终在服务端执行（类似 `task_create` 等工具），需要将其加入 `SERVER_ONLY_TOOLS`：

```java
// ToolDispatcher.java
private static final Set<String> SERVER_ONLY_TOOLS = Set.of(
        "task_create", "task_update", "task_list", "task_delete",
        "delegate");  // 新增
```

### 工具 Prompt 增强

在 `PromptEngine` 中注入子智能体的使用说明：

```java
// PromptEngine.java — buildRequest() 中增加
private String buildDelegateToolPrompt() {
    StringBuilder sb = new StringBuilder();
    sb.append("\n## 子智能体使用指南\n\n");
    sb.append("你可以使用 `delegate` 工具将子任务委托给专门的子智能体。\n\n");
    sb.append("适用场景：\n");
    sb.append("- 大范围代码搜索（超过 3 次查询时值得委托）\n");
    sb.append("- 独立的代码实现任务\n\n");

    for (AgentDefinition def : definitionRegistry.getAllDefinitions()) {
        sb.append("- **").append(def.getAgentType()).append("**: ")
                .append(def.getWhenToUse()).append("\n");
    }

    sb.append("\n注意事项：\n");
    sb.append("- 子智能体不知道当前对话，请在 prompt 中提供完整背景\n");
    sb.append("- 子智能体只返回最终结果，不会展示中间过程\n");
    sb.append("- 简单任务直接使用工具，不要过度委托\n");
    sb.append("- 可以并行启动多个互不依赖的子智能体\n");

    return sb.toString();
}
```

## 八、前端变更

### 1. Session Store 扩展

```typescript
// stores/session.ts — Session 接口扩展
interface Session {
  // ...existing fields...
  parentSessionId?: number | null  // 父会话 ID
  sessionType?: 'main' | 'subagent'  // 会话类型
}
```

### 2. 子智能体事件处理

在 `useStreamWS.ts` 的 `routeEvent()` 中增加子智能体事件处理：

```typescript
// useStreamWS.ts — routeEvent() 中新增

case 'subagent_content_delta':
  // 可选：在父会话中显示子智能体的实时输出
  // 或者只在子智能体会话页面查看
  break

case 'subagent_tool_call_start':
  // 可选：在父会话中显示子智能体正在执行的工具
  break

case 'subagent_error':
  // 子智能体错误，可能需要通知用户
  break

case 'subagent_background_completed':
  // 后台子智能体完成通知（通道 2 的 WS 推送）
  // data: { task_id, child_session_id, status, total_tokens, elapsed_ms, error? }
  // 在父会话中展示完成提示卡片，用户可点击查看子会话详情
  sessionStore.appendSubagentCompletionNotice(data)
  break
```

### 3. 子智能体会话展示（可选 Phase 2）

在聊天界面中，当主 Agent 调用 `delegate` 工具时，可以展示一个可展开的子任务卡片：

- 默认折叠：只显示任务描述和状态
- 点击展开：跳转到子会话查看完整过程
- 后台任务：显示进度指示器

## 九、内置子智能体类型设计

### explore — 代码搜索专家

| 属性 | 值 |
|------|-----|
| 工具 | `read_file`, `glob_search`, `grep_search` |
| 权限 | 只读 |
| 最大轮次 | 10 |
| 默认后台 | 否 |

**典型调用**：
```json
{
  "subagent_type": "explore",
  "description": "搜索认证相关代码",
  "prompt": "找到项目中所有与用户认证、JWT token、登录验证相关的代码文件，报告每个文件的路径和关键函数。"
}
```

### general — 通用委托

| 属性 | 值 |
|------|-----|
| 工具 | 全部（排除 `delegate`） |
| 权限 | 继承父会话 |
| 最大轮次 | 20 |
| 默认后台 | 可选 |

**典型调用**：
```json
{
  "subagent_type": "general",
  "description": "实现用户头像上传",
  "prompt": "在 UserController 中添加头像上传接口。要求：1) 接收 multipart 文件 2) 保存到 /opt/mao/data/avatars/ 3) 更新 user 表的 avatar_url 字段 4) 返回新的头像 URL。参考现有的文件上传实现。"
}
```

## 十、系统 Prompt 注入

在 `PromptEngine` 构建 system prompt 时，注入子智能体使用指南。这样主 Agent 知道何时以及如何使用 `delegate` 工具。

```java
// PromptEngine.java — buildSystemPrompt() 中增加
String systemPrompt = agent.getSystemPrompt()
        + "\n\n" + environmentInfo
        + "\n\n" + buildDelegateToolPrompt()   // 新增
        + "\n\n" + buildToolBehaviorHints();
```

## 十一、实现分期

### Phase 1：核心能力（MVP）

**目标**：子智能体可以被调用并返回结果。

- [ ] `HarnessService.buildContext()` 改为 public（前置条件）
- [ ] `SessionService.saveMessage()` 支持子会话跳过标题生成
- [ ] `Session` 实体新增 `parentSessionId`、`sessionType` 字段
- [ ] 数据库迁移 V040（`parent_session_id`, `session_type`, `subagent_execution` 表，`phase` 允许 NULL）
- [ ] 新增 `AgentDefinition` 和 `AgentDefinitionRegistry`
- [ ] 新增 `SubAgentResultCollector`
- [ ] 新增 `DelegateTool`（仅前台执行，复用 `HarnessService.buildContext()`）
- [ ] `ToolDispatcher` 将 `delegate` 加入 `SERVER_ONLY_TOOLS`
- [ ] `PromptEngine` 注入子智能体使用指南
- [ ] 集成测试：主 Agent 调用 explore 子智能体搜索文件

**预计工作量**：3-5 天

### Phase 2：后台执行 + 事件转发

**目标**：子智能体可以后台运行，前端可选展示执行过程。

- [ ] `DelegateTool` 后台执行模式
- [ ] `AgentLoop` 注入子智能体后台结果
- [ ] `ForwardingEventListener` 实现
- [ ] `StreamingWsHandler` 支持子智能体事件订阅
- [ ] 前端：`useStreamWS` 处理子智能体事件
- [ ] `subagent_execution` 审计表

**预计工作量**：3-4 天

### Phase 3：前端 UI 增强

**目标**：用户可以在界面上看到子智能体的执行状态和结果。

- [ ] 聊天界面：子任务卡片组件（折叠/展开）
- [ ] 子会话详情页：查看子智能体完整对话
- [ ] 后台任务通知：子智能体完成时提示用户
- [ ] Agent 配置页面：配置 agent 级别的子智能体权限

**预计工作量**：4-5 天

### Phase 4：高级特性（远期）

- [ ] 多层嵌套（深度限制）
- [ ] 子智能体之间通信（参考 s09-agent-teams 的 MessageBus 模式）
- [ ] 自定义子智能体类型（用户通过 UI 定义）
- [ ] 子智能体执行统计和成本分析
- [ ] Worktree 隔离（类似 Claude Code 的 `isolation: "worktree"`）

## 十二、设计取舍

### 为什么复用 AgentLoop 而不是另写执行器？

| 方案 | 优点 | 缺点 |
|------|------|------|
| 复用 AgentLoop | 工具执行、权限、压缩、MCP 等能力天然继承；维护一套代码 | 需要确保上下文隔离干净 |
| 另写轻量执行器 | 更简单、更轻量 | 失去工具生态、需要重复实现很多能力 |

选择复用，因为当前项目的 `AgentLoop` 已经包含了工具并行执行、LLM 流式调用、上下文压缩等完整能力。子智能体天然需要这些能力。

### 为什么用独立 session 而不是在 parent session 内嵌套消息？

| 方案 | 优点 | 缺点 |
|------|------|------|
| 独立 session | 消息隔离干净；可以独立查看子会话历史；复用现有 session 基础设施 | 需要额外的 session 记录 |
| parent session 内嵌套 | 不需要新表；消息在同一个会话中 | 会污染主会话上下文；消息结构变复杂 |

选择独立 session，因为 Claude Code 的设计核心就是"保护主上下文窗口"。

### 为什么不支持无限递归嵌套？

子智能体调用子智能体会导致：
- 上下文膨胀（每层都需要传递完整背景）
- 调试困难（调用链过长难以追踪）
- 成本失控（token 消耗指数增长）

Phase 1 直接禁止递归（工具集中排除 `delegate`）。Phase 4 再考虑有限深度嵌套。

## 十三、风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|----------|
| 子智能体 prompt 质量差导致结果无用 | 浪费 token、主 Agent 拿到错误信息 | prompt 模板中强调输出格式；结果中包含子会话 ID 可追溯 |
| 子智能体执行时间过长 | 阻塞主 Agent（前台模式） | 合理设置 maxRounds；长任务使用后台模式 |
| 工具集过滤遗漏 | 子智能体执行了不该执行的操作 | 严格按白名单/黑名单过滤；`delegate` 始终排除 |
| 后台任务结果丢失 | 主 loop 退出后结果无人消费 | 双通道策略：内存队列 + DB 持久化 + WS 通知，确保结果不会丢失 |
| DB SYSTEM 消息与内存队列重复 | 主 Agent 看到两次相同结果 | 通过 `subagent_execution.task_id` 去重；SYSTEM 消息中的 task_id 标记已消费 |
| 数据库 session 数量膨胀 | 子智能体每次调用创建新 session | 可考虑定期清理已完成的子会话；或复用 session |
| AgentLoop ↔ DelegateTool 循环依赖 | Spring 启动失败 | 通过 `@Lazy` 注解打破循环依赖；AgentLoop 延迟获取 DelegateTool 实例 |
| LOCAL 模式下子智能体工具审批 | 子智能体的工具调用通过 `localToolExecutor` 路由到 Electron 客户端执行，但审批 UI 绑定在主会话 WebSocket 上 | 子智能体继承父会话 permissionLevel；建议子智能体默认使用 `FULL` 权限跳过审批，或在 Electron 客户端支持按 sessionId 区分审批来源 |

## 十四、设计审查确认项

以下是设计文档审查过程中确认的关键决策：

| # | 决策 | 理由 |
|---|------|------|
| 1 | 复用 `HarnessService.buildContext()` 构建子智能体上下文 | 自动继承模型配置、环境信息、消息历史加载等；避免与主流程分叉 |
| 2 | 继承父会话模型配置（不支持子智能体指定不同模型） | Phase 1 简化；Phase 2 可在 AgentDefinition 中增加 modelId 覆盖 |
| 3 | 子智能体的 system prompt 走 `PromptEngine.buildRequest()` 自动补全环境信息 | 无需修改 PromptEngine；子智能体也获得 platform/shell/os 等信息 |
| 4 | Phase 1 不处理取消传播 | 子智能体有 maxRounds 限制会自然结束；父会话取消不影响子智能体 |
| 5 | 子会话只用 `status` 字段跟踪（ACTIVE/COMPLETED/FAILED），不用 `phase` | 子智能体执行是瞬时的（从 DelegateTool 视角），不需要 IDLE/RUNNING 中间状态 |
| 6 | 后台结果直接注入 AgentLoop（`@Lazy` 解循环依赖） | 复用现有 `BackgroundTaskManager` 的消费模式；在每轮开始前注入 |
| 7 | DelegateTool 作为独立 Tool 组件，不拆分 | 保持单一入口；职责虽多但逻辑内聚 |
| 8 | 子智能体继承父会话的执行模式和工作区 | LOCAL 就 LOCAL，CLOUD 就 CLOUD；环境信息（platform/shell/os）也一并继承 |
| 9 | 子智能体不加载 skills | 节省 token；子智能体场景简单不需要技能目录 |

## 十五、与 Claude Code 设计的对应关系

| Claude Code 概念 | 本项目对应 |
|------------------|-----------|
| `Agent` 工具 | `DelegateTool` |
| `subagent_type` 参数 | `subagent_type` 参数 |
| `AgentDefinition` | `AgentDefinition` |
| `query()` / `queryLoop()` | `AgentLoop.execute()` |
| `createSubagentContext()` | `DelegateTool.buildSubContext()` |
| `AgentExecutionContext` | `AgentExecutionContext`（复用） |
| `finalizeAgentTool()` | `SubAgentResultCollector` + `buildResultJson()` |
| `WsStreamingEventListener` | `ForwardingEventListener`（可选） |
| sidechain transcript | 独立 session 的 message 记录 |
| `run_in_background` | `run_in_background` 参数 |
| `registerAsyncAgent()` | `DelegateTool.executeInBackground()` |

核心设计保持一致：**同一执行器，多条隔离上下文链**。
