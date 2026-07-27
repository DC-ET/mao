package cn.etarch.mao.harness.tool.impl;

import cn.etarch.mao.harness.tool.Tool;
import cn.etarch.mao.schedule.entity.ScheduledTask;
import cn.etarch.mao.schedule.service.ScheduledTaskService;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.*;
import java.util.stream.Collectors;

@Slf4j
@Component
@RequiredArgsConstructor
public class ListScheduledTasksTool implements Tool {

    private final ScheduledTaskService scheduledTaskService;
    private final ObjectMapper objectMapper;

    @Override
    public String getName() {
        return "list_scheduled_tasks";
    }

    @Override
    public String getDescription() {
        return "列出当前用户的所有定时任务，包括任务名称、状态、cron 表达式、执行次数等信息。";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        return Map.of("type", "object", "properties", Map.of());
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        return Map.of("type", "object");
    }

    @Override
    public String execute(String arguments, Long sessionId, Long userId, String workspace) {
        try {
            List<ScheduledTask> tasks = scheduledTaskService.listByUser(userId);

            List<Map<String, Object>> taskList = tasks.stream().map(t -> {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("id", t.getId());
                m.put("name", t.getName());
                m.put("status", t.getStatus());
                m.put("cron_expression", t.getCronExpression());
                m.put("prompt", t.getPrompt());
                m.put("fire_count", t.getFireCount());
                m.put("last_fire_time", t.getLastFireTime() != null ? t.getLastFireTime().toString() : null);
                m.put("last_execution_status", t.getLastExecutionStatus());
                m.put("next_fire_time", t.getNextFireTime() != null ? t.getNextFireTime().toString() : null);
                m.put("created_at", t.getCreatedAt() != null ? t.getCreatedAt().toString() : null);
                return m;
            }).collect(Collectors.toList());

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("tasks", taskList);
            result.put("total", taskList.size());
            result.put("message", taskList.isEmpty() ? "暂无定时任务" : "共 " + taskList.size() + " 个定时任务");
            return objectMapper.writeValueAsString(result);
        } catch (Exception e) {
            log.error("ListScheduledTasksTool failed", e);
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
