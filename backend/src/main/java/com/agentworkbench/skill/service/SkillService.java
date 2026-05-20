package com.agentworkbench.skill.service;

import com.agentworkbench.agent.entity.AgentSkill;
import com.agentworkbench.agent.mapper.AgentSkillMapper;
import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.agentworkbench.skill.controller.SkillController.CreateSkillRequest;
import com.agentworkbench.skill.entity.SkillEntity;
import com.agentworkbench.skill.mapper.SkillEntityMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
@RequiredArgsConstructor
public class SkillService {

    private final SkillEntityMapper skillEntityMapper;
    private final AgentSkillMapper agentSkillMapper;

    public List<SkillEntity> listSkills() {
        return skillEntityMapper.selectList(null);
    }

    public SkillEntity getSkill(Long id) {
        SkillEntity skill = skillEntityMapper.selectById(id);
        if (skill == null) {
            throw new BusinessException(ErrorCode.SKILL_NOT_FOUND);
        }
        return skill;
    }

    public SkillEntity createSkill(CreateSkillRequest req, Long creatorId) {
        SkillEntity entity = new SkillEntity();
        entity.setName(req.getName());
        entity.setDescription(req.getDescription());
        entity.setType(req.getType());
        entity.setInputSchema(req.getInputSchema());
        entity.setOutputSchema(req.getOutputSchema());
        entity.setImplClass(req.getImplClass());
        entity.setCreatorId(creatorId);
        entity.setStatus("ACTIVE");
        skillEntityMapper.insert(entity);
        return entity;
    }

    public SkillEntity updateSkill(Long id, CreateSkillRequest req) {
        SkillEntity entity = getSkill(id);
        entity.setName(req.getName());
        entity.setDescription(req.getDescription());
        entity.setType(req.getType());
        entity.setInputSchema(req.getInputSchema());
        entity.setOutputSchema(req.getOutputSchema());
        entity.setImplClass(req.getImplClass());
        skillEntityMapper.updateById(entity);
        return entity;
    }

    public void deleteSkill(Long id) {
        getSkill(id);
        // Check if any agent is using this skill
        Long count = agentSkillMapper.selectCount(
                new QueryWrapper<AgentSkill>().eq("skill_id", id));
        if (count > 0) {
            throw new BusinessException(3000, "该 Skill 已被 Agent 关联，无法删除");
        }
        skillEntityMapper.deleteById(id);
    }
}
