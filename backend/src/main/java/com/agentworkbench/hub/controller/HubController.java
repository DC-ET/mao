package com.agentworkbench.hub.controller;

import com.agentworkbench.agent.entity.Agent;
import com.agentworkbench.common.result.Result;
import com.agentworkbench.hub.service.HubService;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/v1/hub")
@RequiredArgsConstructor
public class HubController {

    private final HubService hubService;

    @GetMapping("/agents")
    public Result<List<HubAgentVO>> listHubAgents(
            @RequestParam(required = false) String keyword) {
        List<Agent> agents = hubService.listHubAgents(keyword);
        List<HubAgentVO> voList = agents.stream()
                .map(agent -> toVO(agent))
                .collect(Collectors.toList());
        return Result.ok(voList);
    }

    @PostMapping("/agents/{id}/install")
    public Result<Void> installAgent(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id) {
        hubService.installAgent(userId, id);
        return Result.ok();
    }

    @PostMapping("/agents/{id}/approve")
    public Result<Void> approveAgent(@PathVariable Long id) {
        hubService.approveAgent(id);
        return Result.ok();
    }

    @PostMapping("/agents/{id}/reject")
    public Result<Void> rejectAgent(@PathVariable Long id) {
        hubService.rejectAgent(id);
        return Result.ok();
    }

    private HubAgentVO toVO(Agent agent) {
        HubAgentVO vo = new HubAgentVO();
        vo.setId(agent.getId());
        vo.setName(agent.getName());
        vo.setDescription(agent.getDescription());
        vo.setAuthor(hubService.getAuthorName(agent.getCreatorId()));
        vo.setInstallCount((int) hubService.getInstallCount(agent.getId()));
        vo.setStatus(agent.getStatus());
        vo.setCreatedAt(agent.getCreatedAt() != null ? agent.getCreatedAt().toString() : null);
        return vo;
    }

    @Data
    public static class HubAgentVO {
        private Long id;
        private String name;
        private String description;
        private String author;
        private Integer installCount;
        private String status;
        private String createdAt;
    }
}
