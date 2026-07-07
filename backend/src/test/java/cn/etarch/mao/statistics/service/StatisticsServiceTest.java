package cn.etarch.mao.statistics.service;

import cn.etarch.mao.agent.mapper.AgentMapper;
import cn.etarch.mao.model.entity.LlmModel;
import cn.etarch.mao.model.mapper.LlmModelMapper;
import cn.etarch.mao.session.mapper.MessageMapper;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.user.entity.User;
import cn.etarch.mao.user.mapper.UserMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

@SuppressWarnings("unchecked")
class StatisticsServiceTest {

    private final AgentMapper agentMapper = mock(AgentMapper.class);
    private final LlmModelMapper modelMapper = mock(LlmModelMapper.class);
    private final UserMapper userMapper = mock(UserMapper.class);
    private final SessionMapper sessionMapper = mock(SessionMapper.class);
    private final MessageMapper messageMapper = mock(MessageMapper.class);
    private final StatisticsService service = new StatisticsService(
            agentMapper, modelMapper, userMapper, sessionMapper, messageMapper);

    @Test
    void overviewContainsTotalsAndTodayCounts() {
        when(agentMapper.selectCount(null)).thenReturn(1L);
        when(modelMapper.selectCount(null)).thenReturn(2L);
        when(userMapper.selectCount(null)).thenReturn(3L);
        when(sessionMapper.selectCount(null)).thenReturn(4L);
        when(messageMapper.selectCount(null)).thenReturn(5L);
        when(sessionMapper.selectCount(any(QueryWrapper.class))).thenReturn(6L);
        when(messageMapper.selectCount(any(QueryWrapper.class))).thenReturn(7L);

        Map<String, Object> overview = service.getOverview();

        assertThat(overview).containsEntry("totalAgents", 1L)
                .containsEntry("totalModels", 2L)
                .containsEntry("totalUsers", 3L)
                .containsEntry("totalSessions", 4L)
                .containsEntry("totalMessages", 5L)
                .containsEntry("todaySessions", 6L)
                .containsEntry("todayMessages", 7L);
    }

    @Test
    void agentStatsIncludesMessageAndTokenCountsForSessions() {
        List<Map<String, Object>> expected = List.of(
                Map.of("agentId", 1L, "agentName", "Coder", "sessionCount", 2L, "messageCount", 3L, "totalTokens", 25L),
                Map.of("agentId", 2L, "agentName", "Empty", "sessionCount", 0L, "messageCount", 0L, "totalTokens", 0L));
        when(messageMapper.selectAgentUsageStats()).thenReturn(expected);

        List<Map<String, Object>> stats = service.getAgentStats();

        assertThat(stats).isSameAs(expected);
        assertThat(stats).hasSize(2);
        assertThat(stats.get(0)).containsEntry("agentId", 1L)
                .containsEntry("agentName", "Coder")
                .containsEntry("sessionCount", 2L)
                .containsEntry("messageCount", 3L)
                .containsEntry("totalTokens", 25L);
        assertThat(stats.get(1)).containsEntry("messageCount", 0L)
                .containsEntry("totalTokens", 0L);
    }

    @Test
    void modelStatsCountsMessagesPerModel() {
        when(modelMapper.selectList(null)).thenReturn(List.of(model(1L, "GPT"), model(2L, "Claude")));
        when(messageMapper.selectCount(any(QueryWrapper.class))).thenReturn(10L, 20L);

        List<Map<String, Object>> stats = service.getModelStats();

        assertThat(stats).extracting(row -> row.get("modelName")).containsExactly("GPT", "Claude");
        assertThat(stats).extracting(row -> row.get("messageCount")).containsExactly(10L, 20L);
    }

    @Test
    void userStatsIncludesSessionCountAndLastLogin() {
        User alice = user(1L, "alice");
        alice.setLastLoginAt(LocalDateTime.of(2024, 1, 2, 3, 4));
        User bob = user(2L, "bob");
        when(userMapper.selectList(null)).thenReturn(List.of(alice, bob));
        when(sessionMapper.selectCount(any(QueryWrapper.class))).thenReturn(4L, 0L);

        List<Map<String, Object>> stats = service.getUserStats();

        assertThat(stats.get(0)).containsEntry("username", "alice")
                .containsEntry("sessionCount", 4L);
        assertThat(stats.get(0).get("lastLoginAt")).isEqualTo("2024-01-02T03:04");
        assertThat(stats.get(1).get("lastLoginAt")).isNull();
    }

    private static LlmModel model(Long id, String name) {
        LlmModel model = new LlmModel();
        model.setId(id);
        model.setName(name);
        return model;
    }

    private static User user(Long id, String username) {
        User user = new User();
        user.setId(id);
        user.setUsername(username);
        user.setDisplayName(username);
        return user;
    }

}
