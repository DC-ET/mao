package com.agentworkbench.agent.controller;

import com.agentworkbench.common.result.Result;
import jakarta.validation.constraints.NotBlank;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;

@RestController
@RequestMapping("/v1/agents")
@RequiredArgsConstructor
public class AgentController {

    @GetMapping
    public Result<List<AgentVO>> listAgents(@AuthenticationPrincipal Long userId) {
        // TODO: List agents accessible to user
        return Result.ok();
    }

    @GetMapping("/{id}")
    public Result<AgentVO> getAgent(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        // TODO: Get agent detail
        return Result.ok();
    }

    @PostMapping
    public Result<AgentVO> createAgent(
            @AuthenticationPrincipal Long userId,
            @RequestBody CreateAgentRequest request) {
        // TODO: Create new agent
        return Result.ok();
    }

    @PutMapping("/{id}")
    public Result<AgentVO> updateAgent(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id,
            @RequestBody UpdateAgentRequest request) {
        // TODO: Update agent
        return Result.ok();
    }

    @DeleteMapping("/{id}")
    public Result<Void> deleteAgent(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        // TODO: Delete agent
        return Result.ok();
    }

    @PostMapping("/{id}/publish")
    public Result<Void> publishToHub(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        // TODO: Publish agent to Hub
        return Result.ok();
    }

    // DTOs

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
        private List<Long> skillIds;
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
        private List<Long> skillIds;
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
        private String publishedAt;
        private String createdAt;
    }
}
