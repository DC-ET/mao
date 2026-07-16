package cn.etarch.mao.weixin.service;

import cn.etarch.mao.agent.entity.Agent;
import cn.etarch.mao.agent.service.AgentService;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.session.service.SessionService;
import cn.etarch.mao.settings.service.SystemSettingService;
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
    private AgentService agentService;

    @Mock
    private SystemSettingService systemSettingService;

    private WeixinSessionService weixinSessionService;

    @BeforeEach
    void setUp() {
        weixinSessionService = new WeixinSessionService(
                sessionService, sessionMapper, agentService, systemSettingService);
    }

    @Test
    void getOrCreateWeixinSessionReturnsExistingSessionAndKeepsAgent() {
        Agent agent = agent(10L);
        when(systemSettingService.getValue(SystemSettingService.WEIXIN_AGENT_ID_KEY)).thenReturn("10");
        when(agentService.getAgent(10L)).thenReturn(agent);

        Session existingSession = new Session();
        existingSession.setId(1L);
        existingSession.setUserId(1L);
        existingSession.setAgentId(10L);
        existingSession.setProjectKey("weixin-bot");
        existingSession.setStatus("ACTIVE");
        when(sessionMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(existingSession);

        Session result = weixinSessionService.getOrCreateWeixinSession(1L);

        assertThat(result.getId()).isEqualTo(1L);
        verify(sessionMapper, never()).updateById(any());
        verifyNoInteractions(sessionService);
    }

    @Test
    void getOrCreateWeixinSessionSwitchesAgentOnExistingSession() {
        Agent agent = agent(20L);
        when(systemSettingService.getValue(SystemSettingService.WEIXIN_AGENT_ID_KEY)).thenReturn("20");
        when(agentService.getAgent(20L)).thenReturn(agent);

        Session existingSession = new Session();
        existingSession.setId(1L);
        existingSession.setUserId(1L);
        existingSession.setAgentId(10L);
        existingSession.setProjectKey("weixin-bot");
        existingSession.setStatus("ACTIVE");
        when(sessionMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(existingSession);

        Session result = weixinSessionService.getOrCreateWeixinSession(1L);

        assertThat(result.getAgentId()).isEqualTo(20L);
        verify(sessionMapper).updateById(existingSession);
        verifyNoInteractions(sessionService);
    }

    @Test
    void getOrCreateWeixinSessionCreatesNewSessionWithConfiguredAgent() {
        when(sessionMapper.selectOne(any(LambdaQueryWrapper.class))).thenReturn(null);
        Agent agent = agent(5L);
        when(systemSettingService.getValue(SystemSettingService.WEIXIN_AGENT_ID_KEY)).thenReturn("5");
        when(agentService.getAgent(5L)).thenReturn(agent);

        Session newSession = new Session();
        newSession.setId(2L);
        when(sessionService.createSession(
                anyLong(), anyLong(), anyString(), anyString(),
                any(), anyString(), anyBoolean(), anyString(), anyString(), anyString(),
                any(), anyString(), anyString(), any(), any()
        )).thenReturn(newSession);

        Session result = weixinSessionService.getOrCreateWeixinSession(1L);

        assertThat(result.getId()).isEqualTo(2L);
        verify(sessionService).createSession(
                eq(1L), eq(5L), anyString(), anyString(),
                any(), anyString(), anyBoolean(), anyString(), anyString(), anyString(),
                any(), anyString(), anyString(), any(), any());
    }

    @Test
    void resolveWeixinAgentFallsBackToDefaultWhenUnset() {
        when(systemSettingService.getValue(SystemSettingService.WEIXIN_AGENT_ID_KEY)).thenReturn("");
        Agent defaultAgent = agent(99L);
        when(agentService.requireDefaultAgent()).thenReturn(defaultAgent);

        assertThat(weixinSessionService.resolveWeixinAgent().getId()).isEqualTo(99L);
    }

    private static Agent agent(Long id) {
        Agent agent = new Agent();
        agent.setId(id);
        agent.setName("agent-" + id);
        return agent;
    }
}
