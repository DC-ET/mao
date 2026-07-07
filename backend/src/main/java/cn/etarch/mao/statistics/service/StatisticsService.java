package cn.etarch.mao.statistics.service;

import cn.etarch.mao.agent.mapper.AgentMapper;
import cn.etarch.mao.model.mapper.LlmModelMapper;
import cn.etarch.mao.session.mapper.MessageMapper;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.user.mapper.UserMapper;
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
                new QueryWrapper<cn.etarch.mao.session.entity.Session>().ge("created_at", todayStart)));
        overview.put("todayMessages", messageMapper.selectCount(
                new QueryWrapper<cn.etarch.mao.session.entity.Message>().ge("created_at", todayStart)));

        return overview;
    }

    public List<Map<String, Object>> getAgentStats() {
        return messageMapper.selectAgentUsageStats();
    }

    public List<Map<String, Object>> getModelStats() {
        List<Map<String, Object>> stats = new ArrayList<>();
        // Count messages per model from message table
        List<cn.etarch.mao.model.entity.LlmModel> models = llmModelMapper.selectList(null);
        for (cn.etarch.mao.model.entity.LlmModel model : models) {
            Map<String, Object> stat = new HashMap<>();
            stat.put("modelId", model.getId());
            stat.put("modelName", model.getName());

            Long messageCount = messageMapper.selectCount(
                    new QueryWrapper<cn.etarch.mao.session.entity.Message>().eq("model_id", model.getId()));
            stat.put("messageCount", messageCount);

            stats.add(stat);
        }
        return stats;
    }

    public List<Map<String, Object>> getUserStats() {
        List<Map<String, Object>> stats = new ArrayList<>();
        List<cn.etarch.mao.user.entity.User> users = userMapper.selectList(null);
        for (cn.etarch.mao.user.entity.User user : users) {
            Map<String, Object> stat = new HashMap<>();
            stat.put("userId", user.getId());
            stat.put("username", user.getUsername());
            stat.put("displayName", user.getDisplayName());

            Long sessionCount = sessionMapper.selectCount(
                    new QueryWrapper<cn.etarch.mao.session.entity.Session>().eq("user_id", user.getId()));
            stat.put("sessionCount", sessionCount);

            stat.put("lastLoginAt", user.getLastLoginAt() != null ? user.getLastLoginAt().toString() : null);

            stats.add(stat);
        }
        return stats;
    }
}
