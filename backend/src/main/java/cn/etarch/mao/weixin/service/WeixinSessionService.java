package cn.etarch.mao.weixin.service;

import cn.etarch.mao.agent.entity.Agent;
import cn.etarch.mao.agent.service.AgentService;
import cn.etarch.mao.model.entity.LlmModel;
import cn.etarch.mao.model.service.ModelService;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.session.service.SessionService;
import cn.etarch.mao.settings.service.SystemSettingService;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.util.StringUtils;

import java.util.Objects;

@Slf4j
@Service
@RequiredArgsConstructor
public class WeixinSessionService {

    /** 微信工作区会话的 projectKey，用于会话识别与 Prompt 注入 */
    public static final String PROJECT_KEY = "weixin-bot";

    private final SessionService sessionService;
    private final SessionMapper sessionMapper;
    private final AgentService agentService;
    private final ModelService modelService;
    private final SystemSettingService systemSettingService;

    /**
     * 获取或创建微信Bot会话。
     * 已存在会话时，若配置的微信智能体/模型变更，会同步更新 session。
     */
    public Session getOrCreateWeixinSession(Long userId) {
        Agent agent = resolveWeixinAgent();
        Long modelId = resolveWeixinModelId();

        Session existingSession = findExistingWeixinSession(userId);
        if (existingSession != null) {
            boolean changed = false;
            if (!agent.getId().equals(existingSession.getAgentId())) {
                log.info("微信会话切换 Agent, userId={}, sessionId={}, oldAgentId={}, newAgentId={}",
                        userId, existingSession.getId(), existingSession.getAgentId(), agent.getId());
                existingSession.setAgentId(agent.getId());
                changed = true;
            }
            if (!Objects.equals(modelId, existingSession.getModelId())) {
                log.info("微信会话切换模型, userId={}, sessionId={}, oldModelId={}, newModelId={}",
                        userId, existingSession.getId(), existingSession.getModelId(), modelId);
                existingSession.setModelId(modelId);
                changed = true;
            }
            if (changed) {
                sessionMapper.updateById(existingSession);
            } else {
                log.debug("复用现有微信Bot会话, userId={}, sessionId={}", userId, existingSession.getId());
            }
            return existingSession;
        }

        log.info("创建新的微信Bot会话, userId={}, agentId={}, modelId={}", userId, agent.getId(), modelId);
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
                modelId,
                PROJECT_KEY,
                "new",
                null,
                null
        );
    }

    private Session findExistingWeixinSession(Long userId) {
        LambdaQueryWrapper<Session> wrapper = new LambdaQueryWrapper<>();
        wrapper.eq(Session::getUserId, userId)
                .eq(Session::getProjectKey, PROJECT_KEY)
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
                return agentService.getAgent(agentId);
            } catch (Exception e) {
                log.warn("微信智能体配置无效 ({}), 回退到默认 Agent: {}", configured, e.getMessage());
            }
        }
        return agentService.requireDefaultAgent();
    }

    /**
     * 优先使用系统设置 weixin.modelId；未设置或无效时回退到默认模型。
     * 若系统仍无默认模型，返回 null（运行时由 Harness 再兜底）。
     */
    Long resolveWeixinModelId() {
        String configured = systemSettingService.getValue(SystemSettingService.WEIXIN_MODEL_ID_KEY);
        if (StringUtils.hasText(configured)) {
            try {
                Long modelId = Long.parseLong(configured.trim());
                return modelService.getModel(modelId).getId();
            } catch (Exception e) {
                log.warn("微信模型配置无效 ({}), 回退到默认模型: {}", configured, e.getMessage());
            }
        }
        LlmModel defaultModel = modelService.getDefaultModel();
        return defaultModel != null ? defaultModel.getId() : null;
    }
}
