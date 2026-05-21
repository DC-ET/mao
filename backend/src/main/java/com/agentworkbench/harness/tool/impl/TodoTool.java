package com.agentworkbench.harness.tool.impl;

import com.agentworkbench.harness.tool.Tool;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.Data;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

@Slf4j
@Component
public class TodoTool implements Tool {

    private final ObjectMapper objectMapper;

    // sessionId -> todo items (in-memory, per-session)
    private final Map<Long, List<TodoItem>> sessionTodos = new ConcurrentHashMap<>();

    public TodoTool(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    @Override
    public String getName() {
        return "todo";
    }

    @Override
    public String getDescription() {
        return "Manage a task plan for the current session. Actions: create (add new todos), update (change status), list (show current todos). Each todo has id, content, and status (pending/in_progress/completed). Only one task can be in_progress at a time.";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new HashMap<>();
        properties.put("action", Map.of("type", "string", "enum", new String[]{"create", "update", "list"}));
        properties.put("session_id", Map.of("type", "integer", "description", "Current session ID"));
        properties.put("items", Map.of(
                "type", "array",
                "description", "Todo items (for create/update)",
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
    public String execute(String arguments) {
        try {
            JsonNode args = objectMapper.readTree(arguments);
            String action = args.get("action").asText();
            long sessionId = args.has("session_id") ? args.get("session_id").asLong() : 0;

            return switch (action) {
                case "create" -> handleCreate(sessionId, args.get("items"));
                case "update" -> handleUpdate(sessionId, args.get("items"));
                case "list" -> handleList(sessionId);
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

    private String handleCreate(long sessionId, JsonNode items) throws Exception {
        List<TodoItem> todos = sessionTodos.computeIfAbsent(sessionId, k -> new ArrayList<>());
        int nextId = todos.stream().mapToInt(TodoItem::getId).max().orElse(0) + 1;

        if (items != null && items.isArray()) {
            for (JsonNode item : items) {
                TodoItem todo = new TodoItem();
                todo.setId(nextId++);
                todo.setContent(item.has("content") ? item.get("content").asText() : "");
                todo.setStatus(item.has("status") ? item.get("status").asText() : "pending");
                todos.add(todo);
            }
        }

        return objectMapper.writeValueAsString(Map.of("todos", todos, "message", "Created " + (items != null ? items.size() : 0) + " items"));
    }

    private String handleUpdate(long sessionId, JsonNode items) throws Exception {
        List<TodoItem> todos = sessionTodos.get(sessionId);
        if (todos == null) {
            return objectMapper.writeValueAsString(Map.of("error", "No todos found for this session"));
        }

        if (items != null && items.isArray()) {
            for (JsonNode item : items) {
                int id = item.get("id").asInt();
                String newStatus = item.has("status") ? item.get("status").asText() : null;
                String newContent = item.has("content") ? item.get("content").asText() : null;

                if ("in_progress".equals(newStatus)) {
                    for (TodoItem todo : todos) {
                        if ("in_progress".equals(todo.getStatus()) && todo.getId() != id) {
                            todo.setStatus("pending");
                        }
                    }
                }

                for (TodoItem todo : todos) {
                    if (todo.getId() == id) {
                        if (newStatus != null) todo.setStatus(newStatus);
                        if (newContent != null) todo.setContent(newContent);
                        break;
                    }
                }
            }
        }

        return objectMapper.writeValueAsString(Map.of("todos", todos));
    }

    private String handleList(long sessionId) throws Exception {
        List<TodoItem> todos = sessionTodos.getOrDefault(sessionId, List.of());
        return objectMapper.writeValueAsString(Map.of("todos", todos));
    }

    @Data
    public static class TodoItem {
        private int id;
        private String content;
        private String status;
    }
}
