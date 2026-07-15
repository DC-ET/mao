package cn.etarch.mao.weixin.service;

import cn.etarch.mao.agent.entity.Agent;
import cn.etarch.mao.agent.mapper.AgentMapper;
import cn.etarch.mao.session.entity.Session;
import cn.etarch.mao.session.mapper.SessionMapper;
import cn.etarch.mao.session.service.SessionService;
import com.baomidou.mybatisplus.core.conditions.query.LambdaQueryWrapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;

@Slf4j
@Service
@RequiredArgsConstructor
public class WeixinSessionService {

    private final SessionService sessionService;
    private final SessionMapper sessionMapper;
    private final AgentMapper agentMapper;

    /**
     * 获取或创建微信Bot会话
     */
    public Session getOrCreateWeixinSession(Long userId) {
        // 1. 查找现有的微信Bot会话
        Session existingSession = findExistingWeixinSession(userId);
        if (existingSession != null) {
            log.debug("复用现有微信Bot会话, userId={}, sessionId={}", userId, existingSession.getId());
            return existingSession;
        }

        // 2. 获取默认Agent
        Agent defaultAgent = getDefaultAgent();

        // 3. 创建新的微信Bot会话
        log.info("创建新的微信Bot会话, userId={}, agentId={}", userId, defaultAgent.getId());
        return sessionService.createSession(
                userId,
                defaultAgent.getId(),
                "微信Bot会话",
                "CLOUD",  // 云端模式
                null,     // 工作区路径，由SessionService自动创建
                "READ_ONLY",  // 权限级别
                false,    // 是否Git
                "linux",  // 平台
                "/bin/bash",  // Shell路径
                "Linux",  // 操作系统版本
                null,     // 模型ID
                "weixin-bot",  // 项目Key
                "existing",  // 工作区模式
                null,     // Git克隆URL
                null      // Git分支
        );
    }

    /**
     * 查找现有的微信Bot会话
     */
    private Session findExistingWeixinSession(Long userId) {
        LambdaQueryWrapper<Session> wrapper = new LambdaQueryWrapper<>();
        wrapper.eq(Session::getUserId, userId)
                .eq(Session::getProjectKey, "weixin-bot")
                .eq(Session::getStatus, "ACTIVE")
                .last("LIMIT 1");
        return sessionMapper.selectOne(wrapper);
    }

    /**
     * 获取默认Agent
     */
    private Agent getDefaultAgent() {
        // 获取默认的Agent
        LambdaQueryWrapper<Agent> wrapper = new LambdaQueryWrapper<>();
        wrapper.last("LIMIT 1");
        Agent agent = agentMapper.selectOne(wrapper);

        if (agent == null) {
            // 创建默认Agent
            agent = new Agent();
            agent.setName("微信Bot Agent");
            agent.setDescription("微信Bot专用Agent");
            agent.setSystemPrompt("你是一个AI助手，通过微信与用户交流。请提供简洁、有用的回答。");
            agent.setCreatorId(1L);  // 系统用户ID
            agentMapper.insert(agent);
            log.info("创建默认微信Bot Agent, agentId={}", agent.getId());
        }

        return agent;
    }
}