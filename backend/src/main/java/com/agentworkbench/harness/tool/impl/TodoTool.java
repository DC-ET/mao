package com.agentworkbench.harness.tool.impl;

import com.agentworkbench.harness.todo.entity.SessionTodo;
import com.agentworkbench.harness.todo.mapper.SessionTodoMapper;
import com.agentworkbench.harness.tool.Tool;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.LambdaUpdateWrapper;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.*;

@Slf4j
@Component
public class TodoTool implements Tool {

    private final ObjectMapper objectMapper;
    private final SessionTodoMapper sessionTodoMapper;

    public TodoTool(ObjectMapper objectMapper, SessionTodoMapper sessionTodoMapper) {
        this.objectMapper = objectMapper;
        this.sessionTodoMapper = sessionTodoMapper;
    }

    @Override
    public String getName() {
        return "todo";
    }

    @Override
    public String getDescription() {
        return "Manage a task plan for the current session. Actions: create (add new todos), update (change status/content), delete (remove todos), list (show current todos). Each todo has id, content, and status (pending/in_progress/completed). Only one task can be in_progress at a time.";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("action", Map.of("type", "string", "enum", new String[]{"create", "update", "delete", "list"}));
        properties.put("session_id", Map.of("type", "integer", "description", "Current session ID"));
        properties.put("items", Map.of(
                "type", "array",
                "description", "Todo items (for create/update/delete)",
                "items", Map.of(
                        "type", "object",
                        "properties", Map.of(
                                "id", Map.of("type", "integer"),
                                "content", Map.of("type", "string"),
                                "status", Map.of("type", "string", "enum", new String[]{"pending", "in_progress", "completed"})
                        )
                )
        ));
        schema.put("properties", properties);
        schema.put("required", new String[]{"action"});
        return schema;
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        return schema;
    }

    @Override
    public String execute(String arguments, Long sessionId, String workspace) {
        try {
            JsonNode args = objectMapper.readTree(arguments);
            String action = args.get("action").asText();
            long sid = sessionId != null ? sessionId : (args.has("session_id") ? args.get("session_id").asLong() : 0);

            return switch (action) {
                case "create" -> handleCreate(sid, args.get("items"));
                case "update" -> handleUpdate(sid, args.get("items"));
                case "delete" -> handleDelete(sid, args.get("items"));
                case "list" -> handleList(sid);
                default -> objectMapper.writeValueAsString(Map.of("error", "Unknown action: " + action));
            };
        } catch (Exception e) {
            log.error("TodoTool execution failed", e);
            try {
                return objectMapper.writeValueAsString(Map.of("error", e.getMessage()));
            } catch (Exception ex) {
                return "{\"error\":\"" + e.getMessage().replace("\"", "'") + "\"}";
            }
        }
    }

    @Override
    public String execute(String arguments) {
        return execute(arguments, null, null);
    }

    private String handleCreate(long sessionId, JsonNode items) throws Exception {
        int count = 0;
        if (items != null && items.isArray()) {
            for (JsonNode item : items) {
                SessionTodo todo = new SessionTodo();
                todo.setSessionId(sessionId);
                todo.setContent(item.has("content") ? item.get("content").asText() : "");
                todo.setStatus(item.has("status") ? item.get("status").asText() : "pending");
                sessionTodoMapper.insert(todo);
                count++;
            }
        }

        List<SessionTodo> todos = sessionTodoMapper.selectList(
                new LambdaQueryWrapper<SessionTodo>()
                        .eq(SessionTodo::getSessionId, sessionId)
                        .orderByAsc(SessionTodo::getId));
        return objectMapper.writeValueAsString(Map.of("todos", todos, "message", "Created " + count + " items"));
    }

    private String handleUpdate(long sessionId, JsonNode items) throws Exception {
        if (items != null && items.isArray()) {
            for (JsonNode item : items) {
                long id = item.get("id").asLong();
                String newStatus = item.has("status") ? item.get("status").asText() : null;
                String newContent = item.has("content") ? item.get("content").asText() : null;

                // 把其他 in_progress 重置为 pending（同一会话只有一个 in_progress）
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
                sessionTodoMapper.update(null, updateWrapper);
            }
        }

        List<SessionTodo> todos = sessionTodoMapper.selectList(
                new LambdaQueryWrapper<SessionTodo>()
                        .eq(SessionTodo::getSessionId, sessionId)
                        .orderByAsc(SessionTodo::getId));
        return objectMapper.writeValueAsString(Map.of("todos", todos));
    }

    private String handleDelete(long sessionId, JsonNode items) throws Exception {
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
                        .orderByAsc(SessionTodo::getId));
        return objectMapper.writeValueAsString(Map.of("todos", todos, "message", "Deleted " + count + " items"));
    }

    private String handleList(long sessionId) throws Exception {
        List<SessionTodo> todos = sessionTodoMapper.selectList(
                new LambdaQueryWrapper<SessionTodo>()
                        .eq(SessionTodo::getSessionId, sessionId)
                        .orderByAsc(SessionTodo::getId));
        return objectMapper.writeValueAsString(Map.of("todos", todos));
    }
}
