package com.agentworkbench.agent.service;

import com.agentworkbench.agent.entity.Agent;
import com.agentworkbench.agent.entity.AgentTag;
import com.agentworkbench.agent.mapper.AgentMapper;
import com.agentworkbench.agent.mapper.AgentTagMapper;
import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
@RequiredArgsConstructor
public class AgentService {

    private final AgentMapper agentMapper;
    private final AgentTagMapper agentTagMapper;
    private final ObjectMapper objectMapper;

    public List<Agent> listAgents(Long userId, String keyword) {
        QueryWrapper<Agent> qw = new QueryWrapper<>();
        if (keyword != null && !keyword.isEmpty()) {
            qw.like("name", keyword);
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
    public Agent createAgent(Long userId, String name, String description,
                              String systemPrompt, Long modelId,
                              List<String> tags,
                              List<String> skillNames) {
        Agent agent = new Agent();
        agent.setName(name);
        agent.setDescription(description);
        agent.setSystemPrompt(systemPrompt);
        agent.setModelId(modelId);
        agent.setCreatorId(userId);
        if (skillNames != null && !skillNames.isEmpty()) {
            try {
                agent.setSkillNames(objectMapper.writeValueAsString(skillNames));
            } catch (Exception e) {
                // ignore serialization error
            }
        }
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

        return agent;
    }

    @Transactional
    public Agent updateAgent(Long id, String name, String description,
                              String systemPrompt, Long modelId,
                              List<String> skillNames,
                              List<String> tags) {
        Agent agent = getAgent(id);
        if (name != null) agent.setName(name);
        if (description != null) agent.setDescription(description);
        if (systemPrompt != null) agent.setSystemPrompt(systemPrompt);
        if (modelId != null) agent.setModelId(modelId);
        if (skillNames != null) {
            try {
                agent.setSkillNames(skillNames.isEmpty() ? null : objectMapper.writeValueAsString(skillNames));
            } catch (Exception e) {
                // ignore serialization error
            }
        }
        agentMapper.updateById(agent);

        // Update tags (delete old + insert new)
        if (tags != null) {
            agentTagMapper.delete(new QueryWrapper<AgentTag>().eq("agent_id", id));
            for (String tag : tags) {
                AgentTag agentTag = new AgentTag();
                agentTag.setAgentId(id);
                agentTag.setTag(tag);
                agentTagMapper.insert(agentTag);
            }
        }

        return agent;
    }

    @Transactional
    public void deleteAgent(Long id) {
        agentTagMapper.delete(new QueryWrapper<AgentTag>().eq("agent_id", id));
        agentMapper.deleteById(id);
    }

    public List<AgentTag> getAgentTags(Long agentId) {
        return agentTagMapper.selectList(
                new QueryWrapper<AgentTag>().eq("agent_id", agentId));
    }
}
