package cn.etarch.mao.weixin.service;

import cn.etarch.mao.agent.entity.Agent;
import cn.etarch.mao.agent.service.AgentService;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.session.service.SessionService;
import cn.etarch.mao.settings.service.SystemSettingService;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

@Slf4j
@Service
@RequiredArgsConstructor
public class WeixinSessionService {

    private final SessionService sessionService;
    private final SessionMapper sessionMapper;
    private final AgentService agentService;
    private final SystemSettingService systemSettingService;

    /**
     * 获取或创建微信Bot会话。
     * 已存在会话时，若配置的微信智能体变更，会同步更新 session.agentId。
     */
    public Session getOrCreateWeixinSession(Long userId) {
        Agent agent = resolveWeixinAgent();

        Session existingSession = findExistingWeixinSession(userId);
        if (existingSession != null) {
            if (!agent.getId().equals(existingSession.getAgentId())) {
                log.info("微信会话切换 Agent, userId={}, sessionId={}, oldAgentId={}, newAgentId={}",
                        userId, existingSession.getId(), existingSession.getAgentId(), agent.getId());
                existingSession.setAgentId(agent.getId());
                sessionMapper.updateById(existingSession);
            } else {
                log.debug("复用现有微信Bot会话, userId={}, sessionId={}", userId, existingSession.getId());
            }
            return existingSession;
        }

        log.info("创建新的微信Bot会话, userId={}, agentId={}", userId, agent.getId());
        return sessionService.createSession(
                userId,
                agent.getId(),
                "微信Bot会话",
                "CLOUD",
                null,
                "FULL",
                false,
                "linux",
                "/bin/bash",
                "Linux",
                null,
                "weixin-bot",
                "new",
                null,
                null
        );
    }

    private Session findExistingWeixinSession(Long userId) {
        LambdaQueryWrapper<Session> wrapper = new LambdaQueryWrapper<>();
        wrapper.eq(Session::getUserId, userId)
                .eq(Session::getProjectKey, "weixin-bot")
                .eq(Session::getStatus, "ACTIVE")
                .last("LIMIT 1");
        return sessionMapper.selectOne(wrapper);
    }

    /**
     * 优先使用系统设置 weixin.agentId；未设置或无效时回退到默认 Agent。
     */
    Agent resolveWeixinAgent() {
        String configured = systemSettingService.getValue(SystemSettingService.WEIXIN_AGENT_ID_KEY);
        if (StringUtils.hasText(configured)) {
            try {
                Long agentId = Long.parseLong(configured.trim());
                Agent agent = agentService.getAgent(agentId);
                return agent;
            } catch (Exception e) {
                log.warn("微信智能体配置无效 ({}), 回退到默认 Agent: {}", configured, e.getMessage());
            }
        }
        return agentService.requireDefaultAgent();
    }
}
