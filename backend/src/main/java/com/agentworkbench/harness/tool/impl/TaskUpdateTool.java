package com.agentworkbench.harness.tool.impl;

import com.agentworkbench.harness.todo.entity.SessionTodo;
import com.agentworkbench.harness.todo.mapper.SessionTodoMapper;
import com.agentworkbench.harness.tool.Tool;
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
public class TaskUpdateTool implements Tool {

    private final ObjectMapper objectMapper;
    private final SessionTodoMapper sessionTodoMapper;
    private final ResourceLoader resourceLoader;
    private String cachedPrompt;

    public TaskUpdateTool(ObjectMapper objectMapper, SessionTodoMapper sessionTodoMapper, ResourceLoader resourceLoader) {
        this.objectMapper = objectMapper;
        this.sessionTodoMapper = sessionTodoMapper;
        this.resourceLoader = resourceLoader;
    }

    @Override
    public String getName() {
        return "task_update";
    }

    @Override
    public String getDescription() {
        return """
                Update the status or content of existing todo items.

                STATUS TRANSITIONS:
                - pending → in_progress: Start working on a task. Only ONE task can be in_progress.
                  Setting a task to in_progress automatically resets all other in_progress tasks to pending.
                - in_progress → completed: Mark a task as done. Do this IMMEDIATELY after finishing.
                  Do NOT batch multiple completions — mark each one as soon as it's done.

                IMPORTANT: Always mark tasks as completed one at a time, right after finishing each one.
                After completing a task, use task_list to find your next available task.

                Each item must have: id (required). Optional: status, content, description, active_form.
                """;
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("items", Map.of(
                "type", "array",
                "description", "Todo items to update",
                "items", Map.of(
                        "type", "object",
                        "properties", Map.of(
                                "id", Map.of("type", "integer", "description", "Todo item ID"),
                                "status", Map.of("type", "string", "enum", new String[]{"pending", "in_progress", "completed"}),
                                "content", Map.of("type", "string", "description", "Updated task title"),
                                "description", Map.of("type", "string", "description", "Updated description"),
                                "active_form", Map.of("type", "string", "description", "Updated active form")
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
            cachedPrompt = loadPrompt("prompts/task-update-prompt.md");
        }
        return cachedPrompt;
    }

    @Override
    public String execute(String arguments, Long sessionId, String workspace) {
        try {
            JsonNode args = objectMapper.readTree(arguments);
            JsonNode items = args.get("items");

            boolean transitionedToCompleted = false;
            List<String> updatedSummaries = new ArrayList<>();

            if (items != null && items.isArray()) {
                for (JsonNode item : items) {
                    long id = item.get("id").asLong();
                    String newStatus = item.has("status") ? item.get("status").asText() : null;
                    String newContent = item.has("content") ? item.get("content").asText() : null;
                    String newDescription = item.has("description") ? item.get("description").asText() : null;
                    String newActiveForm = item.has("active_form") ? item.get("active_form").asText() : null;

                    // Enforce single in_progress constraint
                    if ("in_progress".equals(newStatus)) {
                        sessionTodoMapper.update(null,
                                new LambdaUpdateWrapper<SessionTodo>()
                                        .eq(SessionTodo::getSessionId, sessionId)
                                        .eq(SessionTodo::getStatus, "in_progress")
                                        .ne(SessionTodo::getId, id)
                                        .set(SessionTodo::getStatus, "pending"));
                    }

                    LambdaUpdateWrapper<SessionTodo> updateWrapper = new LambdaUpdateWrapper<SessionTodo>()
                            .eq(SessionTodo::getId, id)
                            .eq(SessionTodo::getSessionId, sessionId);
                    if (newStatus != null) {
                        updateWrapper.set(SessionTodo::getStatus, newStatus);
                    }
                    if (newContent != null) {
                        updateWrapper.set(SessionTodo::getContent, newContent);
                    }
                    if (newDescription != null) {
                        updateWrapper.set(SessionTodo::getDescription, newDescription);
                    }
                    if (newActiveForm != null) {
                        updateWrapper.set(SessionTodo::getActiveForm, newActiveForm);
                    }
                    sessionTodoMapper.update(null, updateWrapper);

                    if ("completed".equals(newStatus)) {
                        transitionedToCompleted = true;
                        updatedSummaries.add("Updated task #" + id + " to completed");
                    } else if (newStatus != null) {
                        updatedSummaries.add("Updated task #" + id + " to " + newStatus);
                    }
                }
            }

            List<SessionTodo> todos = sessionTodoMapper.selectList(
                    new LambdaQueryWrapper<SessionTodo>()
                            .eq(SessionTodo::getSessionId, sessionId)
                            .orderByAsc(SessionTodo::getSortOrder)
                            .orderByAsc(SessionTodo::getId));

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("todos", todos);

            if (!updatedSummaries.isEmpty()) {
                result.put("summary", String.join(". ", updatedSummaries));
            }

            // Behavioral feedback based on status transitions
            if (transitionedToCompleted) {
                boolean allDone = todos.stream().allMatch(t -> "completed".equals(t.getStatus()));
                if (allDone && todos.size() >= 3) {
                    boolean hasVerificationTask = todos.stream()
                            .anyMatch(t -> {
                                String c = t.getContent().toLowerCase();
                                return c.contains("verif") || c.contains("验证") || c.contains("测试") || c.contains("test");
                            });
                    if (!hasVerificationTask) {
                        result.put("hint", """
                                All tasks completed. None of them was a verification step.
                                Before writing your final summary, verify the work:
                                - Run relevant tests
                                - Check that the implementation matches requirements
                                - Create a verification task if needed
                                """);
                    } else {
                        result.put("hint", "All tasks completed. Review the todo list and write your final summary.");
                    }
                } else {
                    result.put("hint", "Task completed. Call task_list now to find your next available task.");
                }
            }

            return objectMapper.writeValueAsString(result);
        } catch (Exception e) {
            log.error("TaskUpdateTool execution failed", e);
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
