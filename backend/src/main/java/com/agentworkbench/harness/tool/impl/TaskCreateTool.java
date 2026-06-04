package com.agentworkbench.harness.tool.impl;

import com.agentworkbench.harness.todo.entity.SessionTodo;
import com.agentworkbench.harness.todo.mapper.SessionTodoMapper;
import com.agentworkbench.harness.tool.Tool;
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
                Create todo items to break down multi-step work and track progress.

                WHEN TO USE:
                - Complex multi-step tasks (3+ distinct steps)
                - After receiving new complex instructions — immediately capture requirements as tasks
                - When planning a feature — break it down into concrete, actionable items

                WHEN NOT TO USE:
                - Single, straightforward tasks
                - Trivial tasks where tracking adds no value

                CONTENT FORMAT: Use imperative mood ("Fix authentication bug"), not descriptive ("Auth bug fix").
                Be specific enough that another agent could execute the task.

                Each item can have: content (required), description (optional detail), active_form (present participle, e.g. "Fixing auth bug").
                """;
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("items", Map.of(
                "type", "array",
                "description", "Todo items to create",
                "items", Map.of(
                        "type", "object",
                        "properties", Map.of(
                                "content", Map.of("type", "string", "description", "Task title in imperative mood"),
                                "description", Map.of("type", "string", "description", "Detailed task description"),
                                "active_form", Map.of("type", "string", "description", "Present participle form, e.g. 'Fixing auth bug'")
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
                    SessionTodo todo = new SessionTodo();
                    todo.setSessionId(sessionId);
                    todo.setContent(item.has("content") ? item.get("content").asText() : "");
                    todo.setDescription(item.has("description") ? item.get("description").asText() : "");
                    todo.setActiveForm(item.has("active_form") ? item.get("active_form").asText() : "");
                    todo.setStatus("pending");
                    todo.setSortOrder(count);
                    sessionTodoMapper.insert(todo);
                    count++;
                }
            }

            List<SessionTodo> todos = sessionTodoMapper.selectList(
                    new com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper<SessionTodo>()
                            .eq(SessionTodo::getSessionId, sessionId)
                            .orderByAsc(SessionTodo::getSortOrder)
                            .orderByAsc(SessionTodo::getId));

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("todos", todos);
            result.put("message", "Created " + count + " items");
            result.put("hint", "Tasks created. Begin working on the first pending task by marking it as in_progress.");
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
