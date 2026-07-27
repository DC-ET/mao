package cn.etarch.mao.harness.tool.impl;

import cn.etarch.mao.harness.tool.Tool;
import cn.etarch.mao.schedule.entity.ScheduledTask;
import cn.etarch.mao.schedule.service.ScheduledTaskService;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.LinkedHashMap;
import java.util.Map;

@Slf4j
@Component
@RequiredArgsConstructor
public class DeleteScheduledTaskTool implements Tool {

    private final ScheduledTaskService scheduledTaskService;
    private final ObjectMapper objectMapper;

    @Override
    public String getName() {
        return "delete_scheduled_task";
    }

    @Override
    public String getDescription() {
        return "删除指定的定时任务。删除后任务将不再触发。";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("task_id", Map.of("type", "integer", "description", "要删除的任务 ID"));
        schema.put("properties", properties);
        schema.put("required", new String[]{"task_id"});
        return schema;
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        return Map.of("type", "object");
    }

    @Override
    public String execute(String arguments, Long sessionId, Long userId, String workspace) {
        try {
            var args = objectMapper.readTree(arguments);
            Long taskId = args.get("task_id").asLong();

            // Fetch task name before deleting
            ScheduledTask task = scheduledTaskService.getById(taskId);
            String taskName = task != null ? task.getName() : "未知任务";

            scheduledTaskService.deleteTask(taskId, userId);

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("success", true);
            result.put("task_id", taskId);
            result.put("message", "定时任务 '" + taskName + "' 已删除");
            return objectMapper.writeValueAsString(result);
        } catch (Exception e) {
            log.error("DeleteScheduledTaskTool failed", e);
            return errorJson(e.getMessage());
        }
    }

    @Override
    public String execute(String arguments, Long sessionId, String workspace) {
        return execute(arguments, sessionId, null, workspace);
    }

    @Override
    public String execute(String arguments) {
        return execute(arguments, null, null, null);
    }

    private String errorJson(String message) {
        try {
            return objectMapper.writeValueAsString(Map.of("error", message != null ? message : "未知错误"));
        } catch (Exception ex) {
            return "{\"error\":\"" + (message != null ? message.replace("\"", "'") : "未知错误") + "\"}";
        }
    }
}
