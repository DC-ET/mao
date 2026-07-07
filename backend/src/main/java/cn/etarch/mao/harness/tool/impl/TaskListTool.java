package cn.etarch.mao.harness.tool.impl;

import cn.etarch.mao.harness.todo.entity.SessionTodo;
import cn.etarch.mao.harness.todo.mapper.SessionTodoMapper;
import cn.etarch.mao.harness.tool.Tool;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.io.ResourceLoader;
import org.springframework.stereotype.Component;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.*;

@Slf4j
@Component
public class TaskListTool implements Tool {

    private final ObjectMapper objectMapper;
    private final SessionTodoMapper sessionTodoMapper;
    private final ResourceLoader resourceLoader;
    private String cachedPrompt;

    public TaskListTool(ObjectMapper objectMapper, SessionTodoMapper sessionTodoMapper, ResourceLoader resourceLoader) {
        this.objectMapper = objectMapper;
        this.sessionTodoMapper = sessionTodoMapper;
        this.resourceLoader = resourceLoader;
    }

    @Override
    public String getName() {
        return "task_list";
    }

    @Override
    public String getDescription() {
        return """
                列出当前会话的所有待办事项并查看进展。

                何时使用：
                - 完成一个任务后，用于查找下一个可执行任务
                - 开始工作时，用于查看当前任务计划
                - 不确定下一步时，用于检查剩余任务

                返回所有任务及其状态（pending/in_progress/completed）和进度摘要。
                """;
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new HashMap<>();
        schema.put("type", "object");
        schema.put("properties", new LinkedHashMap<>());
        return schema;
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        return Map.of("type", "object");
    }

    @Override
    public String getToolPrompt() {
        if (cachedPrompt == null) {
            cachedPrompt = loadPrompt("prompts/task-list-prompt.md");
        }
        return cachedPrompt;
    }

    @Override
    public String execute(String arguments, Long sessionId, String workspace) {
        try {
            List<SessionTodo> todos = sessionTodoMapper.selectList(
                    new LambdaQueryWrapper<SessionTodo>()
                            .eq(SessionTodo::getSessionId, sessionId)
                            .orderByAsc(SessionTodo::getSortOrder)
                            .orderByAsc(SessionTodo::getId));

            long completedCount = todos.stream().filter(t -> "completed".equals(t.getStatus())).count();
            long inProgressCount = todos.stream().filter(t -> "in_progress".equals(t.getStatus())).count();

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("todos", todos);
            result.put("progress", "已完成 " + completedCount + "/" + todos.size() + "，进行中 " + inProgressCount);

            if (inProgressCount > 0) {
                result.put("hint", "当前已有任务处于 in_progress。请先继续处理它，再开始其他任务。");
            }

            return objectMapper.writeValueAsString(result);
        } catch (Exception e) {
            log.error("TaskListTool execution failed", e);
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
