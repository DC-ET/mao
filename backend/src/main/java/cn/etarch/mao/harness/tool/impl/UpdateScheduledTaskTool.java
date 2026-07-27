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
public class UpdateScheduledTaskTool implements Tool {

    private final ScheduledTaskService scheduledTaskService;
    private final ObjectMapper objectMapper;

    @Override
    public String getName() {
        return "update_scheduled_task";
    }

    @Override
    public String getDescription() {
        return "更新定时任务。可修改任务名称、prompt 内容、cron 表达式，或启用/禁用任务。";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("task_id", Map.of("type", "integer", "description", "要更新的任务 ID"));
        properties.put("name", Map.of("type", "string", "description", "新的任务名称（可选）"));
        properties.put("prompt", Map.of("type", "string", "description", "新的 prompt 内容（可选）"));
        properties.put("cron_expression", Map.of("type", "string", "description", "新的 cron 表达式（可选）"));
        properties.put("status", Map.of("type", "string", "enum", new String[]{"ACTIVE", "PAUSED"},
                "description", "任务状态：ACTIVE=启用, PAUSED=暂停（可选）"));
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
            String name = args.has("name") ? args.get("name").asText() : null;
            String prompt = args.has("prompt") ? args.get("prompt").asText() : null;
            String cron = args.has("cron_expression") ? args.get("cron_expression").asText() : null;
            String status = args.has("status") ? args.get("status").asText() : null;

            ScheduledTask task = scheduledTaskService.updateTask(taskId, userId, name, prompt, cron, status);

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("success", true);
            result.put("task_id", task.getId());
            result.put("name", task.getName());
            result.put("status", task.getStatus());
            result.put("cron_expression", task.getCronExpression());
            result.put("next_fire_time", task.getNextFireTime() != null ? task.getNextFireTime().toString() : null);
            result.put("message", "定时任务已更新");
            return objectMapper.writeValueAsString(result);
        } catch (Exception e) {
            log.error("UpdateScheduledTaskTool failed", e);
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
