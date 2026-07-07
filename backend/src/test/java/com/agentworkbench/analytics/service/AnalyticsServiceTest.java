package com.agentworkbench.analytics.service;

import com.agentworkbench.agent.entity.Agent;
import com.agentworkbench.agent.mapper.AgentMapper;
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

class AnalyticsServiceTest {

    private final SessionMapper sessionMapper = mock(SessionMapper.class);
    private final MessageMapper messageMapper = mock(MessageMapper.class);
    private final AgentMapper agentMapper = mock(AgentMapper.class);
    private final UserMapper userMapper = mock(UserMapper.class);
    private final AnalyticsService service = new AnalyticsService(sessionMapper, messageMapper, agentMapper, userMapper);

    @Test
    void usageTrendsBuildsOneRowPerDay() {
        when(sessionMapper.selectCount(any(QueryWrapper.class))).thenReturn(1L, 2L, 3L);
        when(messageMapper.selectCount(any(QueryWrapper.class))).thenReturn(10L, 20L, 30L);

        Map<String, Object> result = service.getUsageTrends(3);

        List<Map<String, Object>> trends = (List<Map<String, Object>>) result.get("trends");
        assertThat(trends).hasSize(3);
        assertThat(trends).extracting(row -> row.get("sessions")).containsExactly(1L, 2L, 3L);
        assertThat(trends).extracting(row -> row.get("messages")).containsExactly(10L, 20L, 30L);
    }

    @Test
    void tokenAnalysisMapsAgentNamesAndSortsByTokens() {
        when(messageMapper.selectTokenStatsGroupByAgent()).thenReturn(List.of(
                Map.of("agentId", 2L, "totalTokens", 50, "messageCount", 5),
                Map.of("agentId", 99L, "totalTokens", 200, "messageCount", 10)));
        when(agentMapper.selectList(null)).thenReturn(List.of(agent(2L, "Coder")));

        Map<String, Object> result = service.getTokenAnalysis();

        List<Map<String, Object>> rows = (List<Map<String, Object>>) result.get("agentTokens");
        assertThat(rows).extracting(row -> row.get("totalTokens")).containsExactly(200, 50);
        assertThat(rows.get(0).get("agentName")).isEqualTo("未知");
        assertThat(rows.get(1).get("agentName")).isEqualTo("Coder");
    }

    @Test
    void userActivityCountsSessionsAndMessagesThenSorts() {
        User alice = user(1L, "alice");
        alice.setLastLoginAt(LocalDateTime.of(2024, 1, 1, 12, 0));
        User bob = user(2L, "bob");
        when(userMapper.selectList(null)).thenReturn(List.of(alice, bob));
        when(sessionMapper.selectCount(any(QueryWrapper.class))).thenReturn(1L, 2L);
        when(sessionMapper.selectList(any(QueryWrapper.class)))
                .thenReturn(List.of(session(10L), session(11L)))
                .thenReturn(List.of());
        when(messageMapper.selectCount(any(QueryWrapper.class))).thenReturn(5L);

        Map<String, Object> result = service.getUserActivity();

        List<Map<String, Object>> rows = (List<Map<String, Object>>) result.get("userActivity");
        assertThat(rows).hasSize(2);
        assertThat(rows.get(0).get("username")).isEqualTo("alice");
        assertThat(rows.get(0).get("messageCount")).isEqualTo(5);
        assertThat(rows.get(1).get("lastLoginAt")).isNull();
    }

    @Test
    void agentEfficiencyReturnsEmptyForMissingAgentAndMetricsForExistingAgent() {
        when(agentMapper.selectById(404L)).thenReturn(null);
        assertThat(service.getAgentEfficiency(404L)).isEmpty();

        when(agentMapper.selectById(1L)).thenReturn(agent(1L, "Coder"));
        when(sessionMapper.selectList(any(QueryWrapper.class))).thenReturn(List.of(session(10L), session(11L)));
        Message plain = message(null);
        Message tool = message("[{}]");
        when(messageMapper.selectList(any(QueryWrapper.class)))
                .thenReturn(List.of(plain, tool))
                .thenReturn(List.of(plain));

        Map<String, Object> result = service.getAgentEfficiency(1L);

        assertThat(result).containsEntry("agentName", "Coder");
        assertThat(result).containsEntry("totalSessions", 2);
        assertThat(result).containsEntry("totalMessages", 3);
        assertThat(result).containsEntry("toolCallCount", 1);
        assertThat(result).containsEntry("avgMessagesPerSession", 1.5);
    }

    private static Agent agent(Long id, String name) {
        Agent agent = new Agent();
        agent.setId(id);
        agent.setName(name);
        return agent;
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

    private static Message message(String toolCalls) {
        Message message = new Message();
        message.setToolCalls(toolCalls);
        return message;
    }
}
