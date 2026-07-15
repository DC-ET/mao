package cn.etarch.mao.weixin.service;

import cn.etarch.mao.agent.entity.Agent;
import cn.etarch.mao.agent.mapper.AgentMapper;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.session.service.SessionService;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.mockito.junit.jupiter.MockitoSettings;
import org.mockito.quality.Strictness;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
@MockitoSettings(strictness = Strictness.LENIENT)
class WeixinSessionServiceTest {

    @Mock
    private SessionService sessionService;

    @Mock
    private SessionMapper sessionMapper;

    @Mock
    private AgentMapper agentMapper;

    private WeixinSessionService weixinSessionService;

    @BeforeEach
    void setUp() {
        weixinSessionService = new WeixinSessionService(sessionService, sessionMapper, agentMapper);
    }

    @Test
    void getOrCreateWeixinSessionReturnsExistingSession() {
        Session existingSession = new Session();
        existingSession.setId(1L);
        existingSession.setUserId(1L);
        existingSession.setProjectKey("weixin-bot");
        existingSession.setStatus("ACTIVE");

        when(sessionMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(existingSession);

        Session result = weixinSessionService.getOrCreateWeixinSession(1L);

        assertThat(result).isNotNull();
        assertThat(result.getId()).isEqualTo(1L);
        verifyNoInteractions(sessionService);
    }

    @Test
    void getOrCreateWeixinSessionCreatesNewSessionWhenNotFound() {
        when(sessionMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(null);

        Agent agent = new Agent();
        agent.setId(1L);
        agent.setName("微信Bot Agent");
        when(agentMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(agent);

        Session newSession = new Session();
        newSession.setId(2L);
        newSession.setUserId(1L);
        newSession.setProjectKey("weixin-bot");
        when(sessionService.createSession(
                anyLong(), anyLong(), anyString(), anyString(),
                any(), anyString(), anyBoolean(), anyString(), anyString(), anyString(),
                any(), anyString(), anyString(), any(), any()
        )).thenReturn(newSession);

        Session result = weixinSessionService.getOrCreateWeixinSession(1L);

        assertThat(result).isNotNull();
        assertThat(result.getId()).isEqualTo(2L);
    }

    @Test
    void getOrCreateWeixinSessionCreatesDefaultAgentWhenNotFound() {
        when(sessionMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(null);
        when(agentMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(null);

        // Mock agent insert to set ID
        doAnswer(invocation -> {
            Agent agent = invocation.getArgument(0);
            agent.setId(99L);
            return 1;
        }).when(agentMapper).insert(any(Agent.class));

        Session newSession = new Session();
        newSession.setId(2L);
        newSession.setUserId(1L);
        when(sessionService.createSession(
                anyLong(), anyLong(), anyString(), anyString(),
                any(), anyString(), anyBoolean(), anyString(), anyString(), anyString(),
                any(), anyString(), anyString(), any(), any()
        )).thenReturn(newSession);

        Session result = weixinSessionService.getOrCreateWeixinSession(1L);

        assertThat(result).isNotNull();
        verify(agentMapper).insert(any(Agent.class));
    }
}