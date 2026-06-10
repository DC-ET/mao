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
                更新已有待办事项的状态或内容。

                状态流转：
                - pending → in_progress：开始处理一个任务。同一时间只能有一个任务处于 in_progress。
                  将某个任务设为 in_progress 时，会自动把其他 in_progress 任务重置为 pending。
                - in_progress → completed：将任务标记为完成。请在完成后立即标记。
                  不要批量完成多个任务；每完成一个就立即标记一个。

                重要：始终在每个任务完成后立即逐个标记为 completed。
                完成一个任务后，使用 task_list 查找下一个可执行任务。

                每个事项必须包含：id（必填）。可选字段：status、content、description、active_form。
                """;
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("items", Map.of(
                "type", "array",
                "description", "要更新的待办事项",
                "items", Map.of(
                        "type", "object",
                        "properties", Map.of(
                                "id", Map.of("type", "integer", "description", "待办事项 ID"),
                                "status", Map.of("type", "string", "enum", new String[]{"pending", "in_progress", "completed"}),
                                "content", Map.of("type", "string", "description", "更新后的任务标题"),
                                "description", Map.of("type", "string", "description", "更新后的任务描述"),
                                "active_form", Map.of("type", "string", "description", "更新后的进行中表述")
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
                        updatedSummaries.add("已将任务 #" + id + " 更新为 completed");
                    } else if (newStatus != null) {
                        updatedSummaries.add("已将任务 #" + id + " 更新为 " + newStatus);
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
                                所有任务都已完成，但其中没有验证步骤。
                                在撰写最终总结前，请先验证工作结果：
                                - 运行相关测试
                                - 检查实现是否符合需求
                                - 如有需要，创建一个验证任务
                                """);
                    } else {
                        result.put("hint", "所有任务都已完成。请检查待办列表并撰写最终总结。");
                    }
                } else {
                    result.put("hint", "任务已完成。请立即调用 task_list 查找下一个可执行任务。");
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
