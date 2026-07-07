package com.agentworkbench.admin.service;

import com.agentworkbench.agent.entity.Agent;
import com.agentworkbench.agent.mapper.AgentMapper;
import com.agentworkbench.model.entity.LlmModel;
import com.agentworkbench.model.mapper.LlmModelMapper;
import com.agentworkbench.session.entity.Session;
import com.agentworkbench.session.mapper.MessageMapper;
import com.agentworkbench.session.mapper.SessionMapper;
import com.agentworkbench.statistics.service.StatisticsService;
import com.agentworkbench.user.entity.User;
import com.agentworkbench.user.mapper.UserMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class AdminAnalyticsService {

    private final StatisticsService statisticsService;
    private final SessionMapper sessionMapper;
    private final MessageMapper messageMapper;
    private final LlmModelMapper llmModelMapper;
    private final AgentMapper agentMapper;
    private final UserMapper userMapper;

    public Map<String, Object> summary(int days) {
        Map<String, Object> summary = new LinkedHashMap<>();
        Map<String, Object> overview = new LinkedHashMap<>(statisticsService.getOverview());
        Map<String, Long> phaseCounts = phaseCountMap();
        overview.put("runningSessions", phaseCounts.getOrDefault("RUNNING", 0L));
        overview.put("waitingSessions", phaseCounts.getOrDefault("WAITING_APPROVAL", 0L));
        overview.put("failedSessions", phaseCounts.getOrDefault("FAILED", 0L));
        overview.put("cancelledSessions", phaseCounts.getOrDefault("CANCELLED", 0L));
        summary.put("overview", overview);
        summary.put("trends", trends(days));
        summary.put("phaseDistribution", phaseDistribution(phaseCounts));
        summary.put("tokenStats", tokenStats());
        summary.put("agentStats", messageMapper.selectAgentUsageStats());
        summary.put("userActivity", userActivity());
        summary.put("modelStats", modelStats());
        summary.put("recentFailures", recentFailures());
        return summary;
    }

    private List<Map<String, Object>> trends(int days) {
        int safeDays = Math.max(1, Math.min(days, 90));
        LocalDate firstDay = LocalDate.now().minusDays(safeDays - 1L);
        LocalDateTime start = LocalDateTime.of(firstDay, LocalTime.MIN);
        Map<String, Long> sessionsByDay = countMap(sessionMapper.selectSessionCountsByDay(start), "day", "count");
        Map<String, Long> messagesByDay = countMap(messageMapper.selectMessageCountsByDay(start), "day", "count");
        DateTimeFormatter fmt = DateTimeFormatter.ofPattern("yyyy-MM-dd");

        List<Map<String, Object>> rows = new ArrayList<>();
        for (int i = safeDays - 1; i >= 0; i--) {
            String day = LocalDate.now().minusDays(i).format(fmt);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("date", day);
            row.put("sessions", sessionsByDay.getOrDefault(day, 0L));
            row.put("messages", messagesByDay.getOrDefault(day, 0L));
            rows.add(row);
        }
        return rows;
    }

    private Map<String, Long> phaseCountMap() {
        Map<String, Long> counts = new HashMap<>();
        for (Map<String, Object> row : sessionMapper.selectPhaseCounts()) {
            counts.put(String.valueOf(row.get("phase")), number(row.get("count")));
        }
        return counts;
    }

    private List<Map<String, Object>> phaseDistribution(Map<String, Long> phaseCounts) {
        List<Map<String, Object>> rows = new ArrayList<>();
        List<String> phases = List.of("IDLE", "RUNNING", "RESUMING", "WAITING_APPROVAL", "COMPLETED", "FAILED", "CANCELLED");
        for (String phase : phases) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("phase", phase);
            row.put("count", phaseCounts.getOrDefault(phase, 0L));
            rows.add(row);
        }
        return rows;
    }

    private List<Map<String, Object>> tokenStats() {
        Map<Long, String> agentNames = agentMapper.selectList(null).stream()
                .collect(Collectors.toMap(Agent::getId, Agent::getName));
        List<Map<String, Object>> rows = new ArrayList<>();
        for (Map<String, Object> row : messageMapper.selectTokenStatsGroupByAgent()) {
            Long agentId = number(row.get("agentId"));
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("agentId", agentId);
            item.put("agentName", agentNames.getOrDefault(agentId, "未知"));
            item.put("totalTokens", number(row.get("totalTokens")));
            item.put("messageCount", number(row.get("messageCount")));
            rows.add(item);
        }
        rows.sort((a, b) -> Long.compare((Long) b.get("totalTokens"), (Long) a.get("totalTokens")));
        return rows;
    }

    private List<Map<String, Object>> userActivity() {
        Map<Long, Long> sessionCounts = idCountMap(sessionMapper.selectSessionCountsByUser(), "userId", "sessionCount");
        Map<Long, Long> messageCounts = idCountMap(messageMapper.selectMessageCountsByUser(), "userId", "messageCount");
        List<Map<String, Object>> rows = new ArrayList<>();
        for (User user : userMapper.selectList(null)) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("userId", user.getId());
            row.put("username", user.getUsername());
            row.put("displayName", user.getDisplayName());
            row.put("sessionCount", sessionCounts.getOrDefault(user.getId(), 0L));
            row.put("messageCount", messageCounts.getOrDefault(user.getId(), 0L));
            row.put("lastLoginAt", user.getLastLoginAt() != null ? user.getLastLoginAt().toString() : null);
            rows.add(row);
        }
        rows.sort((a, b) -> Long.compare((Long) b.get("messageCount"), (Long) a.get("messageCount")));
        return rows;
    }

    private List<Map<String, Object>> modelStats() {
        Map<Long, Long> sessionCounts = idCountMap(sessionMapper.selectSessionCountsByModel(), "modelId", "sessionCount");
        Map<Long, Long> messageCounts = idCountMap(messageMapper.selectMessageCountsByModel(), "modelId", "messageCount");
        List<Map<String, Object>> rows = new ArrayList<>();
        List<LlmModel> models = llmModelMapper.selectList(new QueryWrapper<LlmModel>().orderByDesc("created_at"));
        for (LlmModel model : models) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("modelId", model.getId());
            row.put("modelName", model.getName());
            row.put("provider", model.getProvider());
            row.put("status", model.getStatus());
            row.put("isDefault", model.getIsDefault());
            row.put("messageCount", messageCounts.getOrDefault(model.getId(), 0L));
            row.put("sessionCount", sessionCounts.getOrDefault(model.getId(), 0L));
            row.put("contextWindowTokens", model.getContextWindowTokens());
            rows.add(row);
        }
        return rows;
    }

    private List<Map<String, Object>> recentFailures() {
        LocalDateTime since = LocalDateTime.now().minusDays(30);
        List<Session> sessions = sessionMapper.selectList(
                new QueryWrapper<Session>()
                        .eq("phase", "FAILED")
                        .ge("updated_at", since)
                        .orderByDesc("updated_at")
                        .last("LIMIT 10"));
        List<Map<String, Object>> rows = new ArrayList<>();
        for (Session session : sessions) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", session.getId());
            row.put("title", session.getTitle());
            row.put("agentId", session.getAgentId());
            row.put("userId", session.getUserId());
            row.put("executionMode", session.getExecutionMode());
            row.put("updatedAt", session.getUpdatedAt() != null ? session.getUpdatedAt().toString() : null);
            rows.add(row);
        }
        return rows;
    }

    private Map<String, Long> countMap(List<Map<String, Object>> rows, String keyName, String valueName) {
        Map<String, Long> result = new HashMap<>();
        for (Map<String, Object> row : rows) {
            Object key = row.get(keyName);
            if (key != null) {
                result.put(String.valueOf(key), number(row.get(valueName)));
            }
        }
        return result;
    }

    private Map<Long, Long> idCountMap(List<Map<String, Object>> rows, String keyName, String valueName) {
        Map<Long, Long> result = new HashMap<>();
        for (Map<String, Object> row : rows) {
            Object key = row.get(keyName);
            if (key != null) {
                result.put(number(key), number(row.get(valueName)));
            }
        }
        return result;
    }

    private Long number(Object value) {
        if (value instanceof Number n) {
            return n.longValue();
        }
        if (value == null) {
            return 0L;
        }
        return Long.parseLong(value.toString());
    }
}
