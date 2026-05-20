package com.agentworkbench.agent.service;

import com.agentworkbench.agent.entity.Agent;
import com.agentworkbench.agent.entity.AgentMcpConfig;
import com.agentworkbench.agent.entity.AgentSkill;
import com.agentworkbench.agent.entity.AgentTag;
import com.agentworkbench.agent.mapper.AgentMapper;
import com.agentworkbench.agent.mapper.AgentMcpConfigMapper;
import com.agentworkbench.agent.mapper.AgentSkillMapper;
import com.agentworkbench.agent.mapper.AgentTagMapper;
import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.List;

@Service
@RequiredArgsConstructor
public class AgentService {

    private final AgentMapper agentMapper;
    private final AgentTagMapper agentTagMapper;
    private final AgentSkillMapper agentSkillMapper;
    private final AgentMcpConfigMapper agentMcpConfigMapper;

    public List<Agent> listAgents(Long userId, String keyword, String type) {
        QueryWrapper<Agent> qw = new QueryWrapper<>();
        if (keyword != null && !keyword.isEmpty()) {
            qw.like("name", keyword);
        }
        if (type != null && !type.isEmpty()) {
            qw.eq("type", type);
        }
        qw.orderByDesc("created_at");
        return agentMapper.selectList(qw);
    }

    public Agent getAgent(Long id) {
        Agent agent = agentMapper.selectById(id);
        if (agent == null) {
            throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
        }
        return agent;
    }

    @Transactional
    public Agent createAgent(Long userId, String name, String description, String iconUrl,
                              String systemPrompt, Long modelId, String visibility,
                              List<String> tags, List<Long> skillIds,
                              List<AgentMcpConfig> mcpConfigs) {
        Agent agent = new Agent();
        agent.setName(name);
        agent.setDescription(description);
        agent.setIconUrl(iconUrl);
        agent.setSystemPrompt(systemPrompt);
        agent.setModelId(modelId);
        agent.setCreatorId(userId);
        agent.setType("PERSONAL");
        agent.setVisibility(visibility != null ? visibility : "PRIVATE");
        agent.setStatus("DRAFT");
        agent.setTokenLimit(0);
        agent.setMaxRounds(10);
        agentMapper.insert(agent);

        // Save tags
        if (tags != null) {
            for (String tag : tags) {
                AgentTag agentTag = new AgentTag();
                agentTag.setAgentId(agent.getId());
                agentTag.setTag(tag);
                agentTagMapper.insert(agentTag);
            }
        }

        // Save skills
        if (skillIds != null) {
            for (Long skillId : skillIds) {
                AgentSkill agentSkill = new AgentSkill();
                agentSkill.setAgentId(agent.getId());
                agentSkill.setSkillId(skillId);
                agentSkillMapper.insert(agentSkill);
            }
        }

        // Save MCP configs
        if (mcpConfigs != null) {
            for (AgentMcpConfig config : mcpConfigs) {
                config.setAgentId(agent.getId());
                if (config.getStatus() == null) {
                    config.setStatus(1);
                }
                agentMcpConfigMapper.insert(config);
            }
        }

        return agent;
    }

    @Transactional
    public Agent updateAgent(Long id, String name, String description, String iconUrl,
                              String systemPrompt, Long modelId, String visibility,
                              Integer tokenLimit, Integer maxRounds,
                              List<Long> skillIds, List<AgentMcpConfig> mcpConfigs) {
        Agent agent = getAgent(id);
        if (name != null) agent.setName(name);
        if (description != null) agent.setDescription(description);
        if (iconUrl != null) agent.setIconUrl(iconUrl);
        if (systemPrompt != null) agent.setSystemPrompt(systemPrompt);
        if (modelId != null) agent.setModelId(modelId);
        if (visibility != null) agent.setVisibility(visibility);
        if (tokenLimit != null) agent.setTokenLimit(tokenLimit);
        if (maxRounds != null) agent.setMaxRounds(maxRounds);
        agentMapper.updateById(agent);

        // Update skills (delete old + insert new)
        if (skillIds != null) {
            agentSkillMapper.delete(new QueryWrapper<AgentSkill>().eq("agent_id", id));
            for (Long skillId : skillIds) {
                AgentSkill agentSkill = new AgentSkill();
                agentSkill.setAgentId(id);
                agentSkill.setSkillId(skillId);
                agentSkillMapper.insert(agentSkill);
            }
        }

        // Update MCP configs (delete old + insert new)
        if (mcpConfigs != null) {
            agentMcpConfigMapper.delete(new QueryWrapper<AgentMcpConfig>().eq("agent_id", id));
            for (AgentMcpConfig config : mcpConfigs) {
                config.setAgentId(id);
                if (config.getStatus() == null) {
                    config.setStatus(1);
                }
                agentMcpConfigMapper.insert(config);
            }
        }

        return agent;
    }

    public List<Long> getAgentSkillIds(Long agentId) {
        return agentSkillMapper.selectList(
                new QueryWrapper<AgentSkill>().eq("agent_id", agentId))
                .stream().map(AgentSkill::getSkillId).toList();
    }

    public List<AgentMcpConfig> getAgentMcpConfigs(Long agentId) {
        return agentMcpConfigMapper.selectList(
                new QueryWrapper<AgentMcpConfig>().eq("agent_id", agentId));
    }

    @Transactional
    public void deleteAgent(Long id) {
        agentTagMapper.delete(new QueryWrapper<AgentTag>().eq("agent_id", id));
        agentSkillMapper.delete(new QueryWrapper<AgentSkill>().eq("agent_id", id));
        agentMcpConfigMapper.delete(new QueryWrapper<AgentMcpConfig>().eq("agent_id", id));
        agentMapper.deleteById(id);
    }

    public void publishAgent(Long id) {
        Agent agent = getAgent(id);
        agent.setStatus("PUBLISHED");
        agent.setPublishedAt(LocalDateTime.now());
        agentMapper.updateById(agent);
    }

    public List<AgentTag> getAgentTags(Long agentId) {
        return agentTagMapper.selectList(
                new QueryWrapper<AgentTag>().eq("agent_id", agentId));
    }
}
