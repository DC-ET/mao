package cn.etarch.mao.agent.controller;

import cn.etarch.mao.agent.entity.Agent;
import cn.etarch.mao.agent.entity.AgentExperience;
import cn.etarch.mao.agent.entity.AgentTag;
import cn.etarch.mao.agent.service.AgentExperienceService;
import cn.etarch.mao.agent.service.AgentService;
import cn.etarch.mao.common.result.Result;
import cn.etarch.mao.harness.mcp.service.McpServerService;
import cn.etarch.mao.permission.service.PermissionService;
import cn.etarch.mao.user.entity.User;
import cn.etarch.mao.user.mapper.UserMapper;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.validation.constraints.NotBlank;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.Collections;
import java.util.List;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/v1/agents")
@RequiredArgsConstructor
public class AgentController {

    private final AgentService agentService;
    private final AgentExperienceService experienceService;
    private final UserMapper userMapper;
    private final ObjectMapper objectMapper;
    private final PermissionService permissionService;
    private final McpServerService mcpServerService;

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
        List<Long> mcpServerIds = resolveMcpServerIds(userId, request.getMcpServerIds());
        Agent agent = agentService.createAgent(
                userId, request.getName(), request.getDescription(),
                request.getSystemPrompt(),
                request.getTags(),
                request.getSkillNames(),
                mcpServerIds,
                toExperienceInputs(request.getExperiences()),
                request.getIsDefault());
        return Result.ok(toVO(agent));
    }

    @PutMapping("/{id}")
    public Result<AgentVO> updateAgent(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id,
            @RequestBody UpdateAgentRequest request) {
        List<Long> mcpServerIds = resolveMcpServerIds(userId, request.getMcpServerIds());
        Agent agent = agentService.updateAgent(
                id, request.getName(), request.getDescription(),
                request.getSystemPrompt(),
                request.getSkillNames(), mcpServerIds, request.getTags(),
                toExperienceInputs(request.getExperiences()),
                request.getIsDefault());
        return Result.ok(toVO(agent));
    }

    /**
     * 解析并校验 Agent 请求中的 MCP 服务器 ID 列表。
     * 安全约束：MCP 服务器为管理员级全局配置，普通用户无权关联——
     * 关联（写入）需要 mcp:read 权限；同时校验引用的服务器存在且已启用，
     * 防止用户通过 Agent 接口获取或利用未授权的 MCP 服务配置。
     */
    private List<Long> resolveMcpServerIds(Long userId, List<Long> mcpServerIds) {
        if (mcpServerIds == null || mcpServerIds.isEmpty()) {
            return null;
        }
        if (!permissionService.hasPermission(userId, "mcp:read")) {
            throw new cn.etarch.mao.common.exception.BusinessException(
                    cn.etarch.mao.common.result.ErrorCode.FORBIDDEN, "无权限关联 MCP 服务器");
        }
        return mcpServerService.validateForAgent(mcpServerIds);
    }

    @DeleteMapping("/{id}")
    public Result<Void> deleteAgent(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        agentService.deleteAgent(id);
        return Result.ok();
    }

    // ── Experiences 独立 API ──────────────────────────────────────────

    @GetMapping("/{agentId}/experiences")
    public Result<List<ExperienceVO>> listExperiences(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long agentId) {
        agentService.getAgent(agentId);
        List<ExperienceVO> list = experienceService.listByAgentId(agentId).stream()
                .map(this::toExperienceVO)
                .collect(Collectors.toList());
        return Result.ok(list);
    }

    @PostMapping("/{agentId}/experiences")
    public Result<ExperienceVO> createExperience(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long agentId,
            @RequestBody ExperienceRequest request) {
        agentService.getAgent(agentId);
        AgentExperience experience = experienceService.create(
                agentId, request.getContent(), request.getSortOrder(), request.getEnabled());
        return Result.ok(toExperienceVO(experience));
    }

    @PutMapping("/{agentId}/experiences/{id}")
    public Result<ExperienceVO> updateExperience(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long agentId,
            @PathVariable Long id,
            @RequestBody ExperienceRequest request) {
        agentService.getAgent(agentId);
        AgentExperience experience = experienceService.update(
                agentId, id, request.getContent(), request.getSortOrder(), request.getEnabled());
        return Result.ok(toExperienceVO(experience));
    }

    @DeleteMapping("/{agentId}/experiences/{id}")
    public Result<Void> deleteExperience(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long agentId,
            @PathVariable Long id) {
        agentService.getAgent(agentId);
        experienceService.delete(agentId, id);
        return Result.ok();
    }

    private AgentVO toVO(Agent agent) {
        AgentVO vo = new AgentVO();
        vo.setId(agent.getId());
        vo.setName(agent.getName());
        vo.setDescription(agent.getDescription());
        vo.setSystemPrompt(agent.getSystemPrompt());
        vo.setCreatorId(agent.getCreatorId());
        vo.setIsDefault(agent.getIsDefault() != null && agent.getIsDefault() == 1);
        vo.setCreatedAt(agent.getCreatedAt() != null ? agent.getCreatedAt().toString() : null);

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

        // Load MCP server ids
        if (agent.getMcpServerIds() != null) {
            try {
                List<Long> mcpServerIds = objectMapper.readValue(agent.getMcpServerIds(),
                        objectMapper.getTypeFactory().constructCollectionType(List.class, Long.class));
                vo.setMcpServerIds(mcpServerIds);
            } catch (Exception e) {
                // ignore deserialization error
            }
        }

        // Load experiences
        List<AgentExperience> experiences = agentService.getAgentExperiences(agent.getId());
        vo.setExperiences(experiences.stream().map(this::toExperienceVO).collect(Collectors.toList()));

        return vo;
    }

    private ExperienceVO toExperienceVO(AgentExperience experience) {
        ExperienceVO vo = new ExperienceVO();
        vo.setId(experience.getId());
        vo.setContent(experience.getContent());
        vo.setSortOrder(experience.getSortOrder());
        vo.setEnabled(experience.getEnabled() != null && experience.getEnabled() == 1);
        return vo;
    }

    private List<AgentExperienceService.ExperienceInput> toExperienceInputs(List<ExperienceVO> experiences) {
        if (experiences == null) {
            return null;
        }
        return experiences.stream()
                .map(e -> AgentExperienceService.ExperienceInput.of(
                        e.getId(), e.getContent(), e.getSortOrder(), e.getEnabled()))
                .collect(Collectors.toList());
    }

    @Data
    public static class CreateAgentRequest {
        @NotBlank(message = "Agent 名称不能为空")
        private String name;
        private String description;
        @NotBlank(message = "角色定义不能为空")
        private String systemPrompt;
        private List<String> tags;
        private List<String> skillNames;
        private List<Long> mcpServerIds;
        private List<ExperienceVO> experiences;
        private Integer isDefault;
    }

    @Data
    public static class UpdateAgentRequest {
        private String name;
        private String description;
        private String systemPrompt;
        private List<String> skillNames;
        private List<Long> mcpServerIds;
        private List<String> tags;
        private List<ExperienceVO> experiences;
        private Integer isDefault;
    }

    @Data
    public static class ExperienceRequest {
        private String content;
        private Integer sortOrder;
        private Boolean enabled;
    }

    @Data
    public static class ExperienceVO {
        private Long id;
        private String content;
        private Integer sortOrder;
        private Boolean enabled;
    }

    @Data
    public static class AgentVO {
        private Long id;
        private String name;
        private String description;
        private String systemPrompt;
        private Long creatorId;
        private String creatorName;
        private Boolean isDefault;
        private List<String> tags;
        private List<String> skillNames;
        private List<Long> mcpServerIds;
        private List<ExperienceVO> experiences = Collections.emptyList();
        private String createdAt;
    }
}
