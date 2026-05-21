package com.agentworkbench.tool.service;

import com.agentworkbench.agent.entity.AgentTool;
import com.agentworkbench.agent.mapper.AgentToolMapper;
import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.agentworkbench.tool.controller.ToolController.CreateToolRequest;
import com.agentworkbench.tool.entity.ToolEntity;
import com.agentworkbench.tool.mapper.ToolEntityMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
@RequiredArgsConstructor
public class ToolService {

    private final ToolEntityMapper toolEntityMapper;
    private final AgentToolMapper agentToolMapper;

    public List<ToolEntity> listTools() {
        return toolEntityMapper.selectList(null);
    }

    public ToolEntity getTool(Long id) {
        ToolEntity tool = toolEntityMapper.selectById(id);
        if (tool == null) {
            throw new BusinessException(ErrorCode.SKILL_NOT_FOUND);
        }
        return tool;
    }

    public ToolEntity createTool(CreateToolRequest req, Long creatorId) {
        boolean exists = toolEntityMapper.exists(
                new QueryWrapper<ToolEntity>().eq("name", req.getName()));
        if (exists) {
            throw new BusinessException(ErrorCode.SKILL_NAME_DUPLICATE);
        }
        ToolEntity entity = new ToolEntity();
        entity.setName(req.getName());
        entity.setDescription(req.getDescription());
        entity.setType(req.getType());
        entity.setInputSchema(req.getInputSchema());
        entity.setOutputSchema(req.getOutputSchema());
        entity.setImplClass(req.getImplClass());
        entity.setCreatorId(creatorId);
        entity.setStatus("ACTIVE");
        toolEntityMapper.insert(entity);
        return entity;
    }

    public ToolEntity updateTool(Long id, CreateToolRequest req) {
        ToolEntity entity = getTool(id);
        entity.setName(req.getName());
        entity.setDescription(req.getDescription());
        entity.setType(req.getType());
        entity.setInputSchema(req.getInputSchema());
        entity.setOutputSchema(req.getOutputSchema());
        entity.setImplClass(req.getImplClass());
        toolEntityMapper.updateById(entity);
        return entity;
    }

    public void deleteTool(Long id) {
        getTool(id);
        Long count = agentToolMapper.selectCount(
                new QueryWrapper<AgentTool>().eq("tool_id", id));
        if (count > 0) {
            throw new BusinessException(3000, "该 Tool 已被 Agent 关联，无法删除");
        }
        toolEntityMapper.deleteById(id);
    }
}
