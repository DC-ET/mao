package cn.etarch.mao.harness.tool.impl;

import cn.etarch.mao.harness.tool.Tool;
import cn.etarch.mao.schedule.entity.ScheduledTask;
import cn.etarch.mao.schedule.service.ScheduledTaskService;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.service.SessionService;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.*;

@Slf4j
@Component
@RequiredArgsConstructor
public class CreateScheduledTaskTool implements Tool {

    private final ScheduledTaskService scheduledTaskService;
    private final SessionService sessionService;
    private final ObjectMapper objectMapper;

    @Override
    public String getName() {
        return "create_scheduled_task";
    }

    @Override
    public String getDescription() {
        return "创建定时任务。任务将按照指定的 cron 计划自动执行 Agent。" +
                "适用于：定时检查新股、每日生成报告、定期巡检等场景。" +
                "任务创建后会绑定当前 Agent，拥有专属 Session 用于累积执行历史。";
    }

    @Override
    public Map<String, Object> getInputSchema() {
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");
        Map<String, Object> properties = new LinkedHashMap<>();
        properties.put("name", Map.of("type", "string", "description", "任务名称，如'新股申购检查'"));
        properties.put("prompt", Map.of("type", "string",
                "description", "任务触发时执行的 prompt。应完整、自包含，包含足够上下文。" +
                        "示例：'检查今日是否有新股可申购。如果有，列出新股代码、名称、申购价格；如果没有，简要说明。'"));
        properties.put("cron_expression", Map.of("type", "string",
                "description", "Spring cron 表达式（6位：秒 分 时 日 月 周）。" +
                        "示例：'0 0 9 * * ?' 每天9点, '0 */30 * * * ?' 每30分钟, '0 0 9 * * MON-FRI' 工作日9点"));
        schema.put("properties", properties);
        schema.put("required", new String[]{"name", "prompt", "cron_expression"});
        return schema;
    }

    @Override
    public Map<String, Object> getOutputSchema() {
        return Map.of("type", "object");
    }

    @Override
    public String getToolPrompt() {
        return """
                ## create_scheduled_task 使用指南

                当用户希望创建定时自动执行的任务时使用此工具。

                ### cron 表达式规则
                - 格式：秒 分 时 日 月 周（Spring 6位 cron）
                - "每天早上9点" → "0 0 9 * * ?"
                - "每30分钟" → "0 */30 * * * ?"
                - "工作日早上9点" → "0 0 9 * * MON-FRI"
                - "每周一上午10点" → "0 0 10 * * MON"
                - "每月1号早上9点" → "0 0 9 1 * ?"

                ### prompt 编写要求
                - 必须完整、自包含，因为执行时 Agent 只有任务历史，没有用户实时对话
                - 应包含明确的输出要求
                - 好的示例："检查今日是否有新股可申购。如果有，列出新股代码、名称、申购价格和申购上限；如果没有新股，简要说明今日无新股即可。"
                - 差的示例："检查新股"（太简短，缺少上下文和输出要求）
                """;
    }

    @Override
    public String execute(String arguments, Long sessionId, Long userId, String workspace) {
        try {
            var args = objectMapper.readTree(arguments);
            String name = args.get("name").asText();
            String prompt = args.get("prompt").asText();
            String cronExpression = args.get("cron_expression").asText();

            // Get agentId and userId from current session if needed
            Long agentId = null;
            Long resolvedUserId = userId;
            if (sessionId != null) {
                Session currentSession = sessionService.getSession(sessionId);
                if (currentSession != null) {
                    agentId = currentSession.getAgentId();
                    if (resolvedUserId == null) {
                        resolvedUserId = currentSession.getUserId();
                    }
                }
            }
            if (agentId == null) {
                return errorJson("无法获取当前 Agent 信息，请确保在有效会话中创建定时任务");
            }
            if (resolvedUserId == null) {
                return errorJson("无法获取当前用户信息");
            }

            ScheduledTask task = scheduledTaskService.createTask(resolvedUserId, agentId, name, prompt, cronExpression);

            Map<String, Object> result = new LinkedHashMap<>();
            result.put("success", true);
            result.put("task_id", task.getId());
            result.put("name", task.getName());
            result.put("cron_expression", task.getCronExpression());
            result.put("next_fire_time", task.getNextFireTime() != null ? task.getNextFireTime().toString() : null);
            result.put("session_id", task.getSessionId());
            result.put("message", "定时任务 '" + name + "' 已创建，下次执行时间: " + task.getNextFireTime());
            return objectMapper.writeValueAsString(result);
        } catch (Exception e) {
            log.error("CreateScheduledTaskTool failed", e);
            return errorJson(e.getMessage());
        }
    }

    @Override
    public String execute(String arguments, Long sessionId, String workspace) {
        // userId not available in this overload, need to get from session
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
            return "{\"\"error\":\"" + (message != null ? message.replace("\"", "'") : "未知错误") + "\"}";
        }
    }
}
