package cn.etarch.mao.harness.tool.impl;

import cn.etarch.mao.harness.todo.entity.SessionTodo;
import cn.etarch.mao.harness.todo.mapper.SessionTodoMapper;
import cn.etarch.mao.harness.tool.Tool;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.io.ResourceLoader;
import org.springframework.stereotype.Component;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.*;

@Slf4j
@Component
public class TaskCreateTool implements Tool {

    private final ObjectMapper objectMapper;
    private final SessionTodoMapper sessionTodoMapper;
    private final ResourceLoader resourceLoader;
    private String cachedPrompt;

    public TaskCreateTool(ObjectMapper objectMapper, SessionTodoMapper sessionTodoMapper, ResourceLoader resourceLoader) {
        this.objectMapper = objectMapper;
        this.sessionTodoMapper = sessionTodoMapper;
        this.resourceLoader = resourceLoader;
    }

    @Override
    public String getName() {
        return "task_create";
    }

    @Override
    public String getDescription() {
        return """
                创建待办事项，用于拆解多步骤工作并跟踪进展。

                何时使用：
                - 复杂的多步骤任务（3 个或更多明确步骤）
                - 收到新的复杂指令后，立即将需求记录为任务
                - 规划功能时，将其拆解为具体、可执行的事项

                何时不要使用：
                - 单个、直接明了的任务
                - 跟踪不会带来价值的琐碎任务

                内容格式：使用祈使式标题（例如“修复认证问题”），不要使用描述性名词短语（例如“认证问题修复”）。
                任务描述应足够具体，使另一个 Agent 也能据此执行。

                每个事项可包含：content（必填）、description（可选详情）、active_form（进行中的表述，例如“正在修复认证问题”）。
                """;
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("items", Map.of(
                "type", "array",
                "description", "要创建的待办事项",
                "items", Map.of(
                        "type", "object",
                        "properties", Map.of(
                                "content", Map.of("type", "string", "description", "祈使式任务标题"),
                                "description", Map.of("type", "string", "description", "任务的详细描述"),
                                "active_form", Map.of("type", "string", "description", "任务进行中的表述，例如“正在修复认证问题”"),
                                "status", Map.of("type", "string", "enum", new String[]{"pending", "in_progress"}, "description", "初始状态（默认：pending）。同一时间只能有一个任务处于 in_progress。")
                        ),
                        "required", new String[]{"content"}
                )
        ));
        schema.put("properties", properties);
        schema.put("required", new String[]{"items"});
        return schema;
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        return Map.of("type", "object");
    }

    @Override
    public String getToolPrompt() {
        if (cachedPrompt == null) {
            cachedPrompt = loadPrompt("prompts/task-create-prompt.md");
        }
        return cachedPrompt;
    }

    @Override
    public String execute(String arguments, Long sessionId, String workspace) {
        try {
            JsonNode args = objectMapper.readTree(arguments);
            JsonNode items = args.get("items");
            int count = 0;

            if (items != null && items.isArray()) {
                for (JsonNode item : items) {
                    String status = item.has("status") ? item.get("status").asText() : "pending";

                    // Enforce single in_progress constraint
                    if ("in_progress".equals(status)) {
                        sessionTodoMapper.update(null,
                                new LambdaUpdateWrapper<SessionTodo>()
                                        .eq(SessionTodo::getSessionId, sessionId)
                                        .eq(SessionTodo::getStatus, "in_progress")
                                        .set(SessionTodo::getStatus, "pending"));
                    }

                    SessionTodo todo = new SessionTodo();
                    todo.setSessionId(sessionId);
                    todo.setContent(item.has("content") ? item.get("content").asText() : "");
                    todo.setDescription(item.has("description") ? item.get("description").asText() : "");
                    todo.setActiveForm(item.has("active_form") ? item.get("active_form").asText() : "");
                    todo.setStatus(status);
                    todo.setSortOrder(count);
                    sessionTodoMapper.insert(todo);
                    count++;
                }
            }

            List<SessionTodo> todos = sessionTodoMapper.selectList(
                    new LambdaQueryWrapper<SessionTodo>()
                            .eq(SessionTodo::getSessionId, sessionId)
                            .orderByAsc(SessionTodo::getSortOrder)
                            .orderByAsc(SessionTodo::getId));

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("todos", todos);
            result.put("message", "已创建 " + count + " 个事项");
            result.put("hint", "任务已创建。请将第一个 pending 任务标记为 in_progress 后开始执行。");
            return objectMapper.writeValueAsString(result);
        } catch (Exception e) {
            log.error("TaskCreateTool execution failed", e);
            return errorJson(e.getMessage());
        }
    }

    @Override
    public String execute(String arguments) {
        return execute(arguments, null, null);
    }

    private String errorJson(String message) {
        try {
            return objectMapper.writeValueAsString(Map.of("error", message));
        } catch (Exception ex) {
            return "{\"error\":\"" + message.replace("\"", "'") + "\"}";
        }
    }

    private String loadPrompt(String path) {
        try (InputStream is = resourceLoader.getResource("classpath:" + path).getInputStream()) {
            return new String(is.readAllBytes(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            log.warn("Failed to load tool prompt: {}", path, e);
            return null;
        }
    }
}
