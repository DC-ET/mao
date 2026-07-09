package cn.etarch.mao.agent.service;

import cn.etarch.mao.agent.entity.AgentExperience;
import cn.etarch.mao.agent.mapper.AgentExperienceMapper;
import cn.etarch.mao.common.exception.BusinessException;
import cn.etarch.mao.common.result.ErrorCode;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class AgentExperienceService {

    public static final int MAX_CONTENT_LENGTH = 300;

    private final AgentExperienceMapper experienceMapper;

    public List<AgentExperience> listByAgentId(Long agentId) {
        return experienceMapper.selectList(new QueryWrapper<AgentExperience>()
                .eq("agent_id", agentId)
                .orderByAsc("sort_order")
                .orderByAsc("id"));
    }

    public List<String> listEnabledContents(Long agentId) {
        return experienceMapper.selectList(new QueryWrapper<AgentExperience>()
                        .eq("agent_id", agentId)
                        .eq("enabled", 1)
                        .orderByAsc("sort_order")
                        .orderByAsc("id"))
                .stream()
                .map(AgentExperience::getContent)
                .filter(Objects::nonNull)
                .collect(Collectors.toList());
    }

    public AgentExperience getExperience(Long agentId, Long id) {
        AgentExperience experience = experienceMapper.selectById(id);
        if (experience == null || !Objects.equals(experience.getAgentId(), agentId)) {
            throw new BusinessException(ErrorCode.AGENT_EXPERIENCE_NOT_FOUND);
        }
        return experience;
    }

    @Transactional
    public AgentExperience create(Long agentId, String content, Integer sortOrder, Boolean enabled) {
        AgentExperience experience = new AgentExperience();
        experience.setAgentId(agentId);
        experience.setContent(normalizeAndValidateContent(content));
        experience.setSortOrder(sortOrder != null ? sortOrder : 0);
        experience.setEnabled(enabled == null || enabled ? 1 : 0);
        experienceMapper.insert(experience);
        return experience;
    }

    @Transactional
    public AgentExperience update(Long agentId, Long id, String content, Integer sortOrder, Boolean enabled) {
        AgentExperience experience = getExperience(agentId, id);
        if (content != null) {
            experience.setContent(normalizeAndValidateContent(content));
        }
        if (sortOrder != null) {
            experience.setSortOrder(sortOrder);
        }
        if (enabled != null) {
            experience.setEnabled(enabled ? 1 : 0);
        }
        experienceMapper.updateById(experience);
        return experience;
    }

    @Transactional
    public void delete(Long agentId, Long id) {
        AgentExperience experience = getExperience(agentId, id);
        experienceMapper.deleteById(experience.getId());
    }

    @Transactional
    public void deleteByAgentId(Long agentId) {
        experienceMapper.delete(new QueryWrapper<AgentExperience>().eq("agent_id", agentId));
    }

    /**
     * 全量同步：带 id 且属于该 Agent → 更新；无 id → 新增；库中多余 → 删除。
     * items == null 时不改动。
     */
    @Transactional
    public void syncExperiences(Long agentId, List<ExperienceInput> items) {
        if (items == null) {
            return;
        }

        List<AgentExperience> existing = listByAgentId(agentId);
        Set<Long> existingIds = existing.stream()
                .map(AgentExperience::getId)
                .collect(Collectors.toSet());
        Set<Long> keepIds = new HashSet<>();

        for (int i = 0; i < items.size(); i++) {
            ExperienceInput item = items.get(i);
            String content = normalizeAndValidateContent(item.getContent());
            int sortOrder = item.getSortOrder() != null ? item.getSortOrder() : i;
            int enabled = item.getEnabled() == null || item.getEnabled() ? 1 : 0;

            if (item.getId() != null && existingIds.contains(item.getId())) {
                AgentExperience experience = experienceMapper.selectById(item.getId());
                experience.setContent(content);
                experience.setSortOrder(sortOrder);
                experience.setEnabled(enabled);
                experienceMapper.updateById(experience);
                keepIds.add(item.getId());
            } else {
                AgentExperience experience = new AgentExperience();
                experience.setAgentId(agentId);
                experience.setContent(content);
                experience.setSortOrder(sortOrder);
                experience.setEnabled(enabled);
                experienceMapper.insert(experience);
                keepIds.add(experience.getId());
            }
        }

        for (AgentExperience experience : existing) {
            if (!keepIds.contains(experience.getId())) {
                experienceMapper.deleteById(experience.getId());
            }
        }
    }

    public String normalizeAndValidateContent(String content) {
        if (content == null) {
            throw new BusinessException(ErrorCode.AGENT_EXPERIENCE_CONTENT_INVALID);
        }
        String trimmed = content.trim();
        if (trimmed.isEmpty() || trimmed.length() > MAX_CONTENT_LENGTH) {
            throw new BusinessException(ErrorCode.AGENT_EXPERIENCE_CONTENT_INVALID);
        }
        return trimmed;
    }

    @Data
    public static class ExperienceInput {
        private Long id;
        private String content;
        private Integer sortOrder;
        private Boolean enabled;

        public static ExperienceInput of(Long id, String content, Integer sortOrder, Boolean enabled) {
            ExperienceInput input = new ExperienceInput();
            input.setId(id);
            input.setContent(content);
            input.setSortOrder(sortOrder);
            input.setEnabled(enabled);
            return input;
        }
    }
}
