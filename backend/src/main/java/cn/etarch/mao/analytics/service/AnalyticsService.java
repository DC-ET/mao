package cn.etarch.mao.analytics.service;

import cn.etarch.mao.agent.entity.Agent;
import cn.etarch.mao.agent.mapper.AgentMapper;
import cn.etarch.mao.session.entity.Message;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.mapper.MessageMapper;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.user.entity.User;
import cn.etarch.mao.user.mapper.UserMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.format.DateTimeFormatter;
import java.util.*;

@Service
@RequiredArgsConstructor
public class AnalyticsService {

    private final SessionMapper sessionMapper;
    private final MessageMapper messageMapper;
    private final AgentMapper agentMapper;
    private final UserMapper userMapper;

    /**
     * Get usage trends (daily session/message counts for last N days)
     */
    public Map<String, Object> getUsageTrends(int days) {
        Map<String, Object> result = new HashMap<>();
        List<Map<String, Object>> trends = new ArrayList<>();
        DateTimeFormatter fmt = DateTimeFormatter.ofPattern("yyyy-MM-dd");

        for (int i = days - 1; i >= 0; i--) {
            LocalDate date = LocalDate.now().minusDays(i);
            LocalDateTime dayStart = LocalDateTime.of(date, LocalTime.MIN);
            LocalDateTime dayEnd = LocalDateTime.of(date, LocalTime.MAX);

            Long sessions = sessionMapper.selectCount(
                    new QueryWrapper<Session>()
                            .ge("created_at", dayStart)
                            .le("created_at", dayEnd));
            Long messages = messageMapper.selectCount(
                    new QueryWrapper<Message>()
                            .ge("created_at", dayStart)
                            .le("created_at", dayEnd));

            Map<String, Object> dayData = new HashMap<>();
            dayData.put("date", date.format(fmt));
            dayData.put("sessions", sessions);
            dayData.put("messages", messages);
            trends.add(dayData);
        }

        result.put("trends", trends);
        return result;
    }

    /**
     * Get token consumption analysis
     */
    public Map<String, Object> getTokenAnalysis() {
        Map<String, Object> result = new HashMap<>();

        List<Map<String, Object>> stats = messageMapper.selectTokenStatsGroupByAgent();

        Map<Long, String> agentNames = agentMapper.selectList(null).stream()
                .collect(java.util.stream.Collectors.toMap(Agent::getId, Agent::getName));

        List<Map<String, Object>> agentTokens = new ArrayList<>();
        for (Map<String, Object> row : stats) {
            Long agentId = ((Number) row.get("agentId")).longValue();
            Map<String, Object> agentData = new HashMap<>();
            agentData.put("agentId", agentId);
            agentData.put("agentName", agentNames.getOrDefault(agentId, "未知"));
            agentData.put("totalTokens", ((Number) row.get("totalTokens")).intValue());
            agentData.put("messageCount", ((Number) row.get("messageCount")).intValue());
            agentTokens.add(agentData);
        }

        agentTokens.sort((a, b) -> Integer.compare(
                (int) b.get("totalTokens"), (int) a.get("totalTokens")));

        result.put("agentTokens", agentTokens);
        return result;
    }

    /**
     * Get user activity analysis
     */
    public Map<String, Object> getUserActivity() {
        Map<String, Object> result = new HashMap<>();
        List<Map<String, Object>> userActivity = new ArrayList<>();

        List<User> users = userMapper.selectList(null);
        for (User user : users) {
            Long sessionCount = sessionMapper.selectCount(
                    new QueryWrapper<Session>().eq("user_id", user.getId()));

            List<Session> sessions = sessionMapper.selectList(
                    new QueryWrapper<Session>().eq("user_id", user.getId()));
            int messageCount = 0;
            if (!sessions.isEmpty()) {
                List<Long> sessionIds = sessions.stream().map(Session::getId).toList();
                messageCount = messageMapper.selectCount(
                        new QueryWrapper<Message>().in("session_id", sessionIds)).intValue();
            }

            Map<String, Object> userData = new HashMap<>();
            userData.put("userId", user.getId());
            userData.put("username", user.getUsername());
            userData.put("displayName", user.getDisplayName());
            userData.put("sessionCount", sessionCount);
            userData.put("messageCount", messageCount);
            userData.put("lastLoginAt", user.getLastLoginAt() != null ? user.getLastLoginAt().toString() : null);
            userActivity.add(userData);
        }

        // Sort by message count descending
        userActivity.sort((a, b) -> Integer.compare(
                (int) b.get("messageCount"), (int) a.get("messageCount")));

        result.put("userActivity", userActivity);
        return result;
    }

    /**
     * Get agent efficiency analysis
     */
    public Map<String, Object> getAgentEfficiency(Long agentId) {
        Map<String, Object> result = new HashMap<>();
        Agent agent = agentMapper.selectById(agentId);
        if (agent == null) {
            return result;
        }

        List<Session> sessions = sessionMapper.selectList(
                new QueryWrapper<Session>().eq("agent_id", agentId));

        int totalSessions = sessions.size();
        int totalMessages = 0;
        int toolCallCount = 0;

        for (Session session : sessions) {
            List<Message> messages = messageMapper.selectList(
                    new QueryWrapper<Message>().eq("session_id", session.getId()));
            totalMessages += messages.size();
            toolCallCount += messages.stream()
                    .filter(m -> m.getToolCalls() != null && !m.getToolCalls().isEmpty())
                    .count();
        }

        double avgMessagesPerSession = totalSessions > 0 ? (double) totalMessages / totalSessions : 0;
        double toolCallRate = totalMessages > 0 ? (double) toolCallCount / totalMessages : 0;

        result.put("agentId", agentId);
        result.put("agentName", agent.getName());
        result.put("totalSessions", totalSessions);
        result.put("totalMessages", totalMessages);
        result.put("avgMessagesPerSession", Math.round(avgMessagesPerSession * 100.0) / 100.0);
        result.put("toolCallCount", toolCallCount);
        result.put("toolCallRate", Math.round(toolCallRate * 100.0) / 100.0);

        return result;
    }
}
