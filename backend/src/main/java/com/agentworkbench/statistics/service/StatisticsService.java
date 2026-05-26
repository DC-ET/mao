package com.agentworkbench.statistics.service;

import com.agentworkbench.agent.mapper.AgentMapper;
import com.agentworkbench.model.mapper.LlmModelMapper;
import com.agentworkbench.session.mapper.MessageMapper;
import com.agentworkbench.session.mapper.SessionMapper;
import com.agentworkbench.user.mapper.UserMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.util.*;

@Service
@RequiredArgsConstructor
public class StatisticsService {

    private final AgentMapper agentMapper;
    private final LlmModelMapper llmModelMapper;
    private final UserMapper userMapper;
    private final SessionMapper sessionMapper;
    private final MessageMapper messageMapper;

    public Map<String, Object> getOverview() {
        Map<String, Object> overview = new HashMap<>();
        overview.put("totalAgents", agentMapper.selectCount(null));
        overview.put("totalModels", llmModelMapper.selectCount(null));
        overview.put("totalUsers", userMapper.selectCount(null));
        overview.put("totalSessions", sessionMapper.selectCount(null));
        overview.put("totalMessages", messageMapper.selectCount(null));

        // Today's stats
        LocalDateTime todayStart = LocalDateTime.of(LocalDate.now(), LocalTime.MIN);
        overview.put("todaySessions", sessionMapper.selectCount(
                new QueryWrapper<com.agentworkbench.session.entity.Session>().ge("created_at", todayStart)));
        overview.put("todayMessages", messageMapper.selectCount(
                new QueryWrapper<com.agentworkbench.session.entity.Message>().ge("created_at", todayStart)));

        return overview;
    }

    public List<Map<String, Object>> getAgentStats() {
        List<Map<String, Object>> stats = new ArrayList<>();
        // Query agent usage from message table joined with session
        List<com.agentworkbench.agent.entity.Agent> agents = agentMapper.selectList(null);
        for (com.agentworkbench.agent.entity.Agent agent : agents) {
            Map<String, Object> stat = new HashMap<>();
            stat.put("agentId", agent.getId());
            stat.put("agentName", agent.getName());

            // Count sessions for this agent
            Long sessionCount = sessionMapper.selectCount(
                    new QueryWrapper<com.agentworkbench.session.entity.Session>().eq("agent_id", agent.getId()));
            stat.put("sessionCount", sessionCount);

            // Count messages in sessions of this agent
            List<com.agentworkbench.session.entity.Session> sessions = sessionMapper.selectList(
                    new QueryWrapper<com.agentworkbench.session.entity.Session>().eq("agent_id", agent.getId()));
            if (!sessions.isEmpty()) {
                List<Long> sessionIds = sessions.stream()
                        .map(com.agentworkbench.session.entity.Session::getId).toList();
                Long messageCount = messageMapper.selectCount(
                        new QueryWrapper<com.agentworkbench.session.entity.Message>().in("session_id", sessionIds));
                stat.put("messageCount", messageCount);

                // Sum token count
                Integer totalTokens = messageMapper.selectList(
                        new QueryWrapper<com.agentworkbench.session.entity.Message>()
                                .in("session_id", sessionIds)
                                .select("COALESCE(SUM(token_count), 0) as token_count"))
                        .stream()
                        .map(m -> m.getTokenCount())
                        .reduce(0, Integer::sum);
                stat.put("totalTokens", totalTokens);
            } else {
                stat.put("messageCount", 0);
                stat.put("totalTokens", 0);
            }

            stats.add(stat);
        }
        return stats;
    }

    public List<Map<String, Object>> getModelStats() {
        List<Map<String, Object>> stats = new ArrayList<>();
        // Count messages per model from message table
        List<com.agentworkbench.model.entity.LlmModel> models = llmModelMapper.selectList(null);
        for (com.agentworkbench.model.entity.LlmModel model : models) {
            Map<String, Object> stat = new HashMap<>();
            stat.put("modelId", model.getId());
            stat.put("modelName", model.getName());

            Long messageCount = messageMapper.selectCount(
                    new QueryWrapper<com.agentworkbench.session.entity.Message>().eq("model_id", model.getId()));
            stat.put("messageCount", messageCount);

            stats.add(stat);
        }
        return stats;
    }

    public List<Map<String, Object>> getUserStats() {
        List<Map<String, Object>> stats = new ArrayList<>();
        List<com.agentworkbench.user.entity.User> users = userMapper.selectList(null);
        for (com.agentworkbench.user.entity.User user : users) {
            Map<String, Object> stat = new HashMap<>();
            stat.put("userId", user.getId());
            stat.put("username", user.getUsername());
            stat.put("displayName", user.getDisplayName());

            Long sessionCount = sessionMapper.selectCount(
                    new QueryWrapper<com.agentworkbench.session.entity.Session>().eq("user_id", user.getId()));
            stat.put("sessionCount", sessionCount);

            stat.put("lastLoginAt", user.getLastLoginAt() != null ? user.getLastLoginAt().toString() : null);

            stats.add(stat);
        }
        return stats;
    }
}
