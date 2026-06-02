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
                Delete todo items that are no longer relevant.

                WHEN TO USE:
                - A task is no longer relevant or has been superseded
                - User explicitly cancels a task or changes requirements
                - Duplicate tasks were created by mistake

                WHEN NOT TO USE:
                - Do not delete completed tasks (mark as completed instead)
                - Do not delete tasks to avoid working on them

                Each item must have: id (required).
                """;
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("items", Map.of(
                "type", "array",
                "description", "Todo items to delete",
                "items", Map.of(
                        "type", "object",
                        "properties", Map.of(
                                "id", Map.of("type", "integer", "description", "Todo item ID to delete")
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
            result.put("message", "Deleted " + count + " items");
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
