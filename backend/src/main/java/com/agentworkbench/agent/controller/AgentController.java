package com.agentworkbench.agent.controller;

import com.agentworkbench.agent.entity.Agent;
import com.agentworkbench.agent.entity.AgentMcpConfig;
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
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false) String type) {
        List<Agent> agents = agentService.listAgents(userId, keyword, type);
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
        List<AgentMcpConfig> mcpConfigs = null;
        if (request.getMcpConfigs() != null) {
            mcpConfigs = request.getMcpConfigs().stream().map(r -> {
                AgentMcpConfig c = new AgentMcpConfig();
                c.setServerUrl(r.getServerUrl());
                c.setTransport(r.getTransport());
                return c;
            }).toList();
        }
        Agent agent = agentService.createAgent(
                userId, request.getName(), request.getDescription(),
                request.getIconUrl(), request.getSystemPrompt(),
                request.getModelId(), request.getVisibility(),
                request.getTags(), request.getToolIds(),
                request.getSkillNames(), mcpConfigs);
        return Result.ok(toVO(agent));
    }

    @PutMapping("/{id}")
    public Result<AgentVO> updateAgent(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id,
            @RequestBody UpdateAgentRequest request) {
        List<AgentMcpConfig> mcpConfigs = null;
        if (request.getMcpConfigs() != null) {
            mcpConfigs = request.getMcpConfigs().stream().map(r -> {
                AgentMcpConfig c = new AgentMcpConfig();
                c.setServerUrl(r.getServerUrl());
                c.setTransport(r.getTransport());
                return c;
            }).toList();
        }
        Agent agent = agentService.updateAgent(
                id, request.getName(), request.getDescription(),
                request.getIconUrl(), request.getSystemPrompt(),
                request.getModelId(), request.getVisibility(),
                request.getTokenLimit(), request.getMaxRounds(),
                request.getToolIds(), request.getSkillNames(), mcpConfigs);
        return Result.ok(toVO(agent));
    }

    @DeleteMapping("/{id}")
    public Result<Void> deleteAgent(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        agentService.deleteAgent(id);
        return Result.ok();
    }

    @PostMapping("/{id}/publish")
    public Result<Void> publishToHub(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        agentService.publishAgent(id);
        return Result.ok();
    }

    private AgentVO toVO(Agent agent) {
        AgentVO vo = new AgentVO();
        vo.setId(agent.getId());
        vo.setName(agent.getName());
        vo.setDescription(agent.getDescription());
        vo.setIconUrl(agent.getIconUrl());
        vo.setSystemPrompt(agent.getSystemPrompt());
        vo.setModelId(agent.getModelId());
        vo.setCreatorId(agent.getCreatorId());
        vo.setType(agent.getType());
        vo.setVisibility(agent.getVisibility());
        vo.setStatus(agent.getStatus());
        vo.setTokenLimit(agent.getTokenLimit());
        vo.setMaxRounds(agent.getMaxRounds());
        vo.setPublishedAt(agent.getPublishedAt() != null ? agent.getPublishedAt().toString() : null);
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

        // Load tool IDs
        vo.setToolIds(agentService.getAgentToolIds(agent.getId()));

        // Load MCP configs
        vo.setMcpConfigs(agentService.getAgentMcpConfigs(agent.getId()));

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
        private String iconUrl;
        @NotBlank(message = "系统提示词不能为空")
        private String systemPrompt;
        private Long modelId;
        private String visibility;
        private List<String> tags;
        private List<Long> toolIds;
        private List<String> skillNames;
        private List<McpConfigRequest> mcpConfigs;
    }

    @Data
    public static class UpdateAgentRequest {
        private String name;
        private String description;
        private String iconUrl;
        private String systemPrompt;
        private Long modelId;
        private String visibility;
        private Integer tokenLimit;
        private Integer maxRounds;
        private List<Long> toolIds;
        private List<String> skillNames;
        private List<McpConfigRequest> mcpConfigs;
    }

    @Data
    public static class McpConfigRequest {
        private String serverUrl;
        private String transport;
    }

    @Data
    public static class AgentVO {
        private Long id;
        private String name;
        private String description;
        private String iconUrl;
        private String systemPrompt;
        private Long modelId;
        private String modelName;
        private Long creatorId;
        private String creatorName;
        private String type;
        private String visibility;
        private String status;
        private Integer tokenLimit;
        private Integer maxRounds;
        private List<String> tags;
        private List<Long> toolIds;
        private List<String> skillNames;
        private List<AgentMcpConfig> mcpConfigs;
        private String publishedAt;
        private String createdAt;
    }
}
