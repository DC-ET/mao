package com.agentworkbench.hub.service;

import com.agentworkbench.agent.entity.Agent;
import com.agentworkbench.agent.entity.AgentSkill;
import com.agentworkbench.agent.entity.AgentTag;
import com.agentworkbench.agent.mapper.AgentMapper;
import com.agentworkbench.agent.mapper.AgentSkillMapper;
import com.agentworkbench.agent.mapper.AgentTagMapper;
import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.agentworkbench.hub.entity.HubInstallation;
import com.agentworkbench.hub.mapper.HubInstallationMapper;
import com.agentworkbench.user.entity.User;
import com.agentworkbench.user.mapper.UserMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;

@Service
@RequiredArgsConstructor
public class HubService {

    private final AgentMapper agentMapper;
    private final AgentTagMapper agentTagMapper;
    private final AgentSkillMapper agentSkillMapper;
    private final HubInstallationMapper hubInstallationMapper;
    private final UserMapper userMapper;

    /**
     * List published agents in the Hub
     */
    public List<Agent> listHubAgents(String keyword) {
        QueryWrapper<Agent> qw = new QueryWrapper<>();
        qw.eq("status", "PUBLISHED");
        if (keyword != null && !keyword.isEmpty()) {
            qw.like("name", keyword);
        }
        qw.orderByDesc("published_at");
        return agentMapper.selectList(qw);
    }

    /**
     * Get install count for an agent
     */
    public long getInstallCount(Long agentId) {
        return hubInstallationMapper.selectCount(
                new QueryWrapper<HubInstallation>().eq("agent_id", agentId));
    }

    /**
     * Publish an agent to the Hub
     */
    public void publishAgent(Long userId, Long agentId) {
        Agent agent = agentMapper.selectById(agentId);
        if (agent == null) {
            throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
        }
        if (!agent.getCreatorId().equals(userId)) {
            throw new BusinessException(ErrorCode.AGENT_ACCESS_DENIED);
        }
        agent.setStatus("PENDING_REVIEW");
        agent.setPublishedAt(LocalDateTime.now());
        agentMapper.updateById(agent);
    }

    /**
     * Install an agent from the Hub (copy to user's workspace)
     */
    @Transactional
    public Agent installAgent(Long userId, Long agentId) {
        // Check not already installed
        Long exists = hubInstallationMapper.selectCount(
                new QueryWrapper<HubInstallation>()
                        .eq("user_id", userId)
                        .eq("agent_id", agentId));
        if (exists > 0) {
            throw new BusinessException(ErrorCode.HUB_ALREADY_INSTALLED);
        }

        // Copy agent
        Agent original = agentMapper.selectById(agentId);
        if (original == null) {
            throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
        }

        Agent copy = new Agent();
        copy.setName(original.getName());
        copy.setDescription(original.getDescription());
        copy.setIconUrl(original.getIconUrl());
        copy.setSystemPrompt(original.getSystemPrompt());
        copy.setModelId(original.getModelId());
        copy.setCreatorId(userId);
        copy.setType("PERSONAL");
        copy.setVisibility("PRIVATE");
        copy.setStatus("DRAFT");
        copy.setTokenLimit(original.getTokenLimit());
        copy.setMaxRounds(original.getMaxRounds());
        agentMapper.insert(copy);

        // Copy tags
        List<AgentTag> tags = agentTagMapper.selectList(
                new QueryWrapper<AgentTag>().eq("agent_id", agentId));
        for (AgentTag tag : tags) {
            AgentTag newTag = new AgentTag();
            newTag.setAgentId(copy.getId());
            newTag.setTag(tag.getTag());
            agentTagMapper.insert(newTag);
        }

        // Copy skills
        List<AgentSkill> skills = agentSkillMapper.selectList(
                new QueryWrapper<AgentSkill>().eq("agent_id", agentId));
        for (AgentSkill skill : skills) {
            AgentSkill newSkill = new AgentSkill();
            newSkill.setAgentId(copy.getId());
            newSkill.setSkillId(skill.getSkillId());
            newSkill.setConfig(skill.getConfig());
            agentSkillMapper.insert(newSkill);
        }

        // Record installation
        HubInstallation installation = new HubInstallation();
        installation.setUserId(userId);
        installation.setAgentId(agentId);
        installation.setInstalledAt(LocalDateTime.now());
        hubInstallationMapper.insert(installation);

        return copy;
    }

    /**
     * Approve an agent (admin)
     */
    public void approveAgent(Long agentId) {
        Agent agent = agentMapper.selectById(agentId);
        if (agent == null) {
            throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
        }
        agent.setStatus("PUBLISHED");
        agentMapper.updateById(agent);
    }

    /**
     * Reject an agent (admin)
     */
    public void rejectAgent(Long agentId) {
        Agent agent = agentMapper.selectById(agentId);
        if (agent == null) {
            throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
        }
        agent.setStatus("REJECTED");
        agentMapper.updateById(agent);
    }

    /**
     * Get author name for an agent
     */
    public String getAuthorName(Long creatorId) {
        if (creatorId == null) return null;
        User user = userMapper.selectById(creatorId);
        return user != null ? user.getDisplayName() : null;
    }
}
