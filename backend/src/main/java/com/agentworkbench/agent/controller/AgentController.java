package com.agentworkbench.agent.controller;

import com.agentworkbench.agent.entity.Agent;
import com.agentworkbench.agent.entity.AgentTag;
import com.agentworkbench.agent.service.AgentService;
import com.agentworkbench.common.result.Result;
import com.agentworkbench.model.entity.LlmModel;
import com.agentworkbench.model.mapper.LlmModelMapper;
import com.agentworkbench.user.entity.User;
import com.agentworkbench.user.mapper.UserMapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.validation.constraints.NotBlank;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/v1/agents")
@RequiredArgsConstructor
public class AgentController {

    private final AgentService agentService;
    private final LlmModelMapper llmModelMapper;
    private final UserMapper userMapper;
    private final ObjectMapper objectMapper;

    @GetMapping
    public Result<List<AgentVO>> listAgents(
            @AuthenticationPrincipal Long userId,
            @RequestParam(required = false) String keyword) {
        List<Agent> agents = agentService.listAgents(userId, keyword);
        List<AgentVO> voList = agents.stream().map(this::toVO).collect(Collectors.toList());
        return Result.ok(voList);
    }

    @GetMapping("/{id}")
    public Result<AgentVO> getAgent(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        return Result.ok(toVO(agentService.getAgent(id)));
    }

    @PostMapping
    public Result<AgentVO> createAgent(
            @AuthenticationPrincipal Long userId,
            @RequestBody CreateAgentRequest request) {
        Agent agent = agentService.createAgent(
                userId, request.getName(), request.getDescription(),
                request.getSystemPrompt(),
                request.getModelId(),
                request.getTags(),
                request.getSkillNames());
        return Result.ok(toVO(agent));
    }

    @PutMapping("/{id}")
    public Result<AgentVO> updateAgent(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id,
            @RequestBody UpdateAgentRequest request) {
        Agent agent = agentService.updateAgent(
                id, request.getName(), request.getDescription(),
                request.getSystemPrompt(),
                request.getModelId(),
                request.getSkillNames(), request.getTags());
        return Result.ok(toVO(agent));
    }

    @DeleteMapping("/{id}")
    public Result<Void> deleteAgent(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        agentService.deleteAgent(id);
        return Result.ok();
    }

    private AgentVO toVO(Agent agent) {
        AgentVO vo = new AgentVO();
        vo.setId(agent.getId());
        vo.setName(agent.getName());
        vo.setDescription(agent.getDescription());
        vo.setSystemPrompt(agent.getSystemPrompt());
        vo.setModelId(agent.getModelId());
        vo.setCreatorId(agent.getCreatorId());
        vo.setCreatedAt(agent.getCreatedAt() != null ? agent.getCreatedAt().toString() : null);

        // Load model name
        if (agent.getModelId() != null) {
            LlmModel model = llmModelMapper.selectById(agent.getModelId());
            if (model != null) {
                vo.setModelName(model.getName());
            }
        }

        // Load creator name
        if (agent.getCreatorId() != null) {
            User creator = userMapper.selectById(agent.getCreatorId());
            if (creator != null) {
                vo.setCreatorName(creator.getDisplayName());
            }
        }

        // Load tags
        List<AgentTag> tags = agentService.getAgentTags(agent.getId());
        vo.setTags(tags.stream().map(AgentTag::getTag).collect(Collectors.toList()));

        // Load skill names
        if (agent.getSkillNames() != null) {
            try {
                List<String> skillNames = objectMapper.readValue(agent.getSkillNames(),
                        objectMapper.getTypeFactory().constructCollectionType(List.class, String.class));
                vo.setSkillNames(skillNames);
            } catch (Exception e) {
                // ignore deserialization error
            }
        }

        return vo;
    }

    @Data
    public static class CreateAgentRequest {
        @NotBlank(message = "Agent 名称不能为空")
        private String name;
        private String description;
        @NotBlank(message = "系统提示词不能为空")
        private String systemPrompt;
        private Long modelId;
        private List<String> tags;
        private List<String> skillNames;
    }

    @Data
    public static class UpdateAgentRequest {
        private String name;
        private String description;
        private String systemPrompt;
        private Long modelId;
        private List<String> skillNames;
        private List<String> tags;
    }

    @Data
    public static class AgentVO {
        private Long id;
        private String name;
        private String description;
        private String systemPrompt;
        private Long modelId;
        private String modelName;
        private Long creatorId;
        private String creatorName;
        private List<String> tags;
        private List<String> skillNames;
        private String createdAt;
    }
}
