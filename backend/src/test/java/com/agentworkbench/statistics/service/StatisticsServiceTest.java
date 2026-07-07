package com.agentworkbench.statistics.service;

import com.agentworkbench.agent.entity.Agent;
import com.agentworkbench.agent.mapper.AgentMapper;
import com.agentworkbench.model.entity.LlmModel;
import com.agentworkbench.model.mapper.LlmModelMapper;
import com.agentworkbench.session.entity.Message;
import com.agentworkbench.session.entity.Session;
import com.agentworkbench.session.mapper.MessageMapper;
import com.agentworkbench.session.mapper.SessionMapper;
import com.agentworkbench.user.entity.User;
import com.agentworkbench.user.mapper.UserMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

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
        when(agentMapper.selectList(null)).thenReturn(List.of(agent(1L, "Coder"), agent(2L, "Empty")));
        when(sessionMapper.selectCount(any(QueryWrapper.class))).thenReturn(2L, 0L);
        when(sessionMapper.selectList(any(QueryWrapper.class)))
                .thenReturn(List.of(session(10L), session(11L)))
                .thenReturn(List.of());
        when(messageMapper.selectCount(any(QueryWrapper.class))).thenReturn(3L);
        Message t1 = message(10);
        Message t2 = message(15);
        when(messageMapper.selectList(any(QueryWrapper.class))).thenReturn(List.of(t1, t2));

        List<Map<String, Object>> stats = service.getAgentStats();

        assertThat(stats).hasSize(2);
        assertThat(stats.get(0)).containsEntry("agentId", 1L)
                .containsEntry("agentName", "Coder")
                .containsEntry("sessionCount", 2L)
                .containsEntry("messageCount", 3L)
                .containsEntry("totalTokens", 25);
        assertThat(stats.get(1)).containsEntry("messageCount", 0)
                .containsEntry("totalTokens", 0);
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

    private static Agent agent(Long id, String name) {
        Agent agent = new Agent();
        agent.setId(id);
        agent.setName(name);
        return agent;
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

    private static Session session(Long id) {
        Session session = new Session();
        session.setId(id);
        return session;
    }

    private static Message message(Integer tokenCount) {
        Message message = new Message();
        message.setTokenCount(tokenCount);
        return message;
    }
}
