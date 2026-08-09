package cn.etarch.mao.statistics.service;

import cn.etarch.mao.agent.mapper.AgentMapper;
import cn.etarch.mao.model.mapper.LlmModelMapper;
import cn.etarch.mao.session.mapper.MessageMapper;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.user.mapper.UserMapper;
import cn.etarch.mao.usage.mapper.LlmUsageMapper;
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
    private final LlmUsageMapper llmUsageMapper;

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

            Map<String, Object> background = llmUsageMapper.sumByModelId(model.getId());
            stat.put("backgroundCallCount", number(background, "callCount"));
            stat.put("backgroundPromptTokens", number(background, "promptTokens"));
            stat.put("backgroundCompletionTokens", number(background, "completionTokens"));
            long messageTokens = Optional.ofNullable(messageMapper.selectTokenCountByModel(model.getId())).orElse(0L);
            long backgroundTokens = number(background, "totalTokens");
            stat.put("messageTokens", messageTokens);
            stat.put("backgroundTotalTokens", backgroundTokens);
            stat.put("totalTokens", messageTokens + backgroundTokens);

            stats.add(stat);
        }
        return stats;
    }

    private static long number(Map<String, Object> values, String key) {
        Object value = values != null ? values.get(key) : null;
        return value instanceof Number number ? number.longValue() : 0L;
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
