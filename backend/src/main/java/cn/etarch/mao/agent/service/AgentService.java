package cn.etarch.mao.agent.service;

import cn.etarch.mao.agent.entity.Agent;
import cn.etarch.mao.agent.entity.AgentExperience;
import cn.etarch.mao.agent.entity.AgentTag;
import cn.etarch.mao.agent.mapper.AgentMapper;
import cn.etarch.mao.agent.mapper.AgentTagMapper;
import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
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
    private final AgentExperienceService experienceService;
    private final ObjectMapper objectMapper;

    public List<Agent> listAgents(Long userId, String keyword) {
        QueryWrapper<Agent> qw = new QueryWrapper<>();
        if (keyword != null && !keyword.isEmpty()) {
            qw.like("name", keyword);
        }
        qw.orderByDesc("is_default").orderByDesc("created_at");
        return agentMapper.selectList(qw);
    }

    public Agent getAgent(Long id) {
        Agent agent = agentMapper.selectById(id);
        if (agent == null) {
            throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
        }
        return agent;
    }

    public Agent getDefaultAgent() {
        return agentMapper.selectOne(new QueryWrapper<Agent>().eq("is_default", 1).last("LIMIT 1"));
    }

    public Agent requireDefaultAgent() {
        Agent agent = getDefaultAgent();
        if (agent == null) {
            throw new BusinessException(ErrorCode.AGENT_NOT_FOUND, "未配置默认 Agent，请先在管理后台设置");
        }
        return agent;
    }

    @Transactional
    public Agent createAgent(Long userId, String name, String description,
                              String systemPrompt,
                              List<String> tags,
                              List<String> skillNames,
                              List<AgentExperienceService.ExperienceInput> experiences,
                              Integer isDefault) {
        if (isDefault != null && isDefault == 1) {
            clearDefaultFlag();
        }
        Agent agent = new Agent();
        agent.setName(name);
        agent.setDescription(description);
        agent.setSystemPrompt(systemPrompt);
        agent.setCreatorId(userId);
        agent.setIsDefault(isDefault != null ? isDefault : 0);
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

        if (experiences != null) {
            experienceService.syncExperiences(agent.getId(), experiences);
        }

        return agent;
    }

    @Transactional
    public Agent updateAgent(Long id, String name, String description,
                              String systemPrompt,
                              List<String> skillNames,
                              List<String> tags,
                              List<AgentExperienceService.ExperienceInput> experiences,
                              Integer isDefault) {
        Agent agent = getAgent(id);
        if (name != null) agent.setName(name);
        if (description != null) agent.setDescription(description);
        if (systemPrompt != null) agent.setSystemPrompt(systemPrompt);
        if (skillNames != null) {
            try {
                agent.setSkillNames(skillNames.isEmpty() ? null : objectMapper.writeValueAsString(skillNames));
            } catch (Exception e) {
                // ignore serialization error
            }
        }
        if (isDefault != null) {
            if (isDefault == 1) {
                clearDefaultFlag();
            }
            agent.setIsDefault(isDefault);
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

        // experiences == null → 不改动；[] → 清空
        experienceService.syncExperiences(id, experiences);

        return agent;
    }

    @Transactional
    public void deleteAgent(Long id) {
        Agent agent = getAgent(id);
        if (agent.getIsDefault() != null && agent.getIsDefault() == 1) {
            throw new BusinessException(ErrorCode.AGENT_IS_DEFAULT);
        }
        agentTagMapper.delete(new QueryWrapper<AgentTag>().eq("agent_id", id));
        experienceService.deleteByAgentId(id);
        agentMapper.deleteById(id);
    }

    public List<AgentTag> getAgentTags(Long agentId) {
        return agentTagMapper.selectList(
                new QueryWrapper<AgentTag>().eq("agent_id", agentId));
    }

    public List<AgentExperience> getAgentExperiences(Long agentId) {
        return experienceService.listByAgentId(agentId);
    }

    private void clearDefaultFlag() {
        Agent update = new Agent();
        update.setIsDefault(0);
        agentMapper.update(update, new QueryWrapper<Agent>().eq("is_default", 1));
    }
}
