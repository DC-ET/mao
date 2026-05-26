package com.agentworkbench.hub.controller;

import com.agentworkbench.agent.entity.Agent;
import com.agentworkbench.common.result.Result;
import com.agentworkbench.hub.entity.AgentComment;
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
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false) String category) {
        List<Agent> agents;
        if (category != null && !category.isEmpty()) {
            agents = hubService.listByCategory(category);
        } else {
            agents = hubService.listHubAgents(keyword);
        }
        List<HubAgentVO> voList = agents.stream()
                .map(this::toVO)
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

    @PostMapping("/agents/{id}/rate")
    public Result<Void> rateAgent(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id,
            @RequestBody RateRequest request) {
        hubService.rateAgent(userId, id, request.getScore());
        return Result.ok();
    }

    @GetMapping("/agents/{id}/comments")
    public Result<List<CommentVO>> getComments(@PathVariable Long id) {
        List<AgentComment> comments = hubService.getComments(id);
        List<CommentVO> voList = comments.stream()
                .map(this::toCommentVO)
                .collect(Collectors.toList());
        return Result.ok(voList);
    }

    @PostMapping("/agents/{id}/comments")
    public Result<CommentVO> addComment(
            @AuthenticationPrincipal Long userId,
            @PathVariable Long id,
            @RequestBody CommentRequest request) {
        AgentComment comment = hubService.addComment(userId, id, request.getContent());
        return Result.ok(toCommentVO(comment));
    }

    @GetMapping("/agents/recommended")
    public Result<List<HubAgentVO>> getRecommended(
            @RequestParam(defaultValue = "10") int limit) {
        List<Agent> agents = hubService.getRecommendedAgents(limit);
        List<HubAgentVO> voList = agents.stream()
                .map(this::toVO)
                .collect(Collectors.toList());
        return Result.ok(voList);
    }

    @GetMapping("/agents/ranking")
    public Result<List<HubAgentVO>> getRanking(
            @RequestParam(defaultValue = "hot") String type,
            @RequestParam(defaultValue = "10") int limit) {
        List<Agent> agents = hubService.getRankingAgents(type, limit);
        List<HubAgentVO> voList = agents.stream()
                .map(this::toVO)
                .collect(Collectors.toList());
        return Result.ok(voList);
    }

    @GetMapping("/categories")
    public Result<List<String>> getCategories() {
        return Result.ok(hubService.getCategories());
    }

    private HubAgentVO toVO(Agent agent) {
        HubAgentVO vo = new HubAgentVO();
        vo.setId(agent.getId());
        vo.setName(agent.getName());
        vo.setDescription(agent.getDescription());
        vo.setCategory(agent.getCategory());
        vo.setAuthor(hubService.getAuthorName(agent.getCreatorId()));
        vo.setInstallCount((int) hubService.getInstallCount(agent.getId()));
        vo.setAvgRating(hubService.getAverageRating(agent.getId()));
        vo.setRatingCount((int) hubService.getRatingCount(agent.getId()));
        vo.setStatus(agent.getStatus());
        vo.setCreatedAt(agent.getCreatedAt() != null ? agent.getCreatedAt().toString() : null);
        return vo;
    }

    private CommentVO toCommentVO(AgentComment comment) {
        CommentVO vo = new CommentVO();
        vo.setId(comment.getId());
        vo.setUserId(comment.getUserId());
        vo.setAgentId(comment.getAgentId());
        vo.setContent(comment.getContent());
        vo.setCreatedAt(comment.getCreatedAt() != null ? comment.getCreatedAt().toString() : null);
        return vo;
    }

    @Data
    public static class HubAgentVO {
        private Long id;
        private String name;
        private String description;
        private String category;
        private String author;
        private Integer installCount;
        private Double avgRating;
        private Integer ratingCount;
        private String status;
        private String createdAt;
    }

    @Data
    public static class RateRequest {
        private Integer score;
    }

    @Data
    public static class CommentRequest {
        private String content;
    }

    @Data
    public static class CommentVO {
        private Long id;
        private Long userId;
        private Long agentId;
        private String content;
        private String createdAt;
    }
}
