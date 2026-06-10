package com.agentworkbench.harness.tool.impl;

import com.agentworkbench.harness.todo.entity.SessionTodo;
import com.agentworkbench.harness.todo.mapper.SessionTodoMapper;
import com.agentworkbench.harness.tool.Tool;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
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
public class TaskDeleteTool implements Tool {

    private final ObjectMapper objectMapper;
    private final SessionTodoMapper sessionTodoMapper;
    private final ResourceLoader resourceLoader;
    private String cachedPrompt;

    public TaskDeleteTool(ObjectMapper objectMapper, SessionTodoMapper sessionTodoMapper, ResourceLoader resourceLoader) {
        this.objectMapper = objectMapper;
        this.sessionTodoMapper = sessionTodoMapper;
        this.resourceLoader = resourceLoader;
    }

    @Override
    public String getName() {
        return "task_delete";
    }

    @Override
    public String getDescription() {
        return """
                删除不再相关的待办事项。

                何时使用：
                - 某个任务不再相关，或已被其他任务取代
                - 用户明确取消任务或变更需求
                - 误创建了重复任务

                何时不要使用：
                - 不要删除已完成任务（应标记为 completed）
                - 不要为了逃避执行而删除任务

                每个事项必须包含：id（必填）。
                """;
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("items", Map.of(
                "type", "array",
                "description", "要删除的待办事项",
                "items", Map.of(
                        "type", "object",
                        "properties", Map.of(
                                "id", Map.of("type", "integer", "description", "要删除的待办事项 ID")
                        ),
                        "required", new String[]{"id"}
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
            cachedPrompt = loadPrompt("prompts/task-delete-prompt.md");
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
                    long id = item.get("id").asLong();
                    sessionTodoMapper.delete(
                            new LambdaQueryWrapper<SessionTodo>()
                                    .eq(SessionTodo::getId, id)
                                    .eq(SessionTodo::getSessionId, sessionId));
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
            result.put("message", "已删除 " + count + " 个事项");
            return objectMapper.writeValueAsString(result);
        } catch (Exception e) {
            log.error("TaskDeleteTool execution failed", e);
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
