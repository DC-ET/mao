package com.agentworkbench.hub.service;

import com.agentworkbench.agent.entity.Agent;
import com.agentworkbench.agent.entity.AgentTool;
import com.agentworkbench.agent.entity.AgentTag;
import com.agentworkbench.agent.mapper.AgentMapper;
import com.agentworkbench.agent.mapper.AgentToolMapper;
import com.agentworkbench.agent.mapper.AgentTagMapper;
import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.agentworkbench.hub.entity.AgentComment;
import com.agentworkbench.hub.entity.AgentRating;
import com.agentworkbench.hub.entity.HubInstallation;
import com.agentworkbench.hub.mapper.AgentCommentMapper;
import com.agentworkbench.hub.mapper.AgentRatingMapper;
import com.agentworkbench.hub.mapper.HubInstallationMapper;
import com.agentworkbench.user.entity.User;
import com.agentworkbench.user.mapper.UserMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.LocalDateTime;
import java.util.*;

@Service
@RequiredArgsConstructor
public class HubService {

    private final AgentMapper agentMapper;
    private final AgentTagMapper agentTagMapper;
    private final AgentToolMapper agentToolMapper;
    private final HubInstallationMapper hubInstallationMapper;
    private final AgentRatingMapper agentRatingMapper;
    private final AgentCommentMapper agentCommentMapper;
    private final UserMapper userMapper;

    /**
     * List published agents in the Hub
     */
    public List<Agent> listHubAgents(String keyword) {
        QueryWrapper<Agent> qw = new QueryWrapper<>();
        qw.eq("status", "PUBLISHED");
        if (keyword != null && !keyword.isEmpty()) {
            qw.like("name", keyword);
        }
        qw.orderByDesc("published_at");
        return agentMapper.selectList(qw);
    }

    /**
     * Get install count for an agent
     */
    public long getInstallCount(Long agentId) {
        return hubInstallationMapper.selectCount(
                new QueryWrapper<HubInstallation>().eq("agent_id", agentId));
    }

    /**
     * Publish an agent to the Hub
     */
    public void publishAgent(Long userId, Long agentId) {
        Agent agent = agentMapper.selectById(agentId);
        if (agent == null) {
            throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
        }
        if (!agent.getCreatorId().equals(userId)) {
            throw new BusinessException(ErrorCode.AGENT_ACCESS_DENIED);
        }
        agent.setStatus("PENDING_REVIEW");
        agent.setPublishedAt(LocalDateTime.now());
        agentMapper.updateById(agent);
    }

    /**
     * Install an agent from the Hub (copy to user's workspace)
     */
    @Transactional
    public Agent installAgent(Long userId, Long agentId) {
        // Check not already installed
        Long exists = hubInstallationMapper.selectCount(
                new QueryWrapper<HubInstallation>()
                        .eq("user_id", userId)
                        .eq("agent_id", agentId));
        if (exists > 0) {
            throw new BusinessException(ErrorCode.HUB_ALREADY_INSTALLED);
        }

        // Copy agent
        Agent original = agentMapper.selectById(agentId);
        if (original == null) {
            throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
        }

        Agent copy = new Agent();
        copy.setName(original.getName());
        copy.setDescription(original.getDescription());
        copy.setIconUrl(original.getIconUrl());
        copy.setSystemPrompt(original.getSystemPrompt());
        copy.setModelId(original.getModelId());
        copy.setCreatorId(userId);
        copy.setType("PERSONAL");
        copy.setVisibility("PRIVATE");
        copy.setStatus("DRAFT");
        copy.setTokenLimit(original.getTokenLimit());
        copy.setMaxRounds(original.getMaxRounds());
        agentMapper.insert(copy);

        // Copy tags
        List<AgentTag> tags = agentTagMapper.selectList(
                new QueryWrapper<AgentTag>().eq("agent_id", agentId));
        for (AgentTag tag : tags) {
            AgentTag newTag = new AgentTag();
            newTag.setAgentId(copy.getId());
            newTag.setTag(tag.getTag());
            agentTagMapper.insert(newTag);
        }

        // Copy tools
        List<AgentTool> tools = agentToolMapper.selectList(
                new QueryWrapper<AgentTool>().eq("agent_id", agentId));
        for (AgentTool tool : tools) {
            AgentTool newTool = new AgentTool();
            newTool.setAgentId(copy.getId());
            newTool.setToolId(tool.getToolId());
            newTool.setConfig(tool.getConfig());
            agentToolMapper.insert(newTool);
        }

        // Record installation
        HubInstallation installation = new HubInstallation();
        installation.setUserId(userId);
        installation.setAgentId(agentId);
        installation.setInstalledAt(LocalDateTime.now());
        hubInstallationMapper.insert(installation);

        return copy;
    }

    /**
     * Approve an agent (admin)
     */
    public void approveAgent(Long agentId) {
        Agent agent = agentMapper.selectById(agentId);
        if (agent == null) {
            throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
        }
        agent.setStatus("PUBLISHED");
        agentMapper.updateById(agent);
    }

    /**
     * Reject an agent (admin)
     */
    public void rejectAgent(Long agentId) {
        Agent agent = agentMapper.selectById(agentId);
        if (agent == null) {
            throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
        }
        agent.setStatus("REJECTED");
        agentMapper.updateById(agent);
    }

    /**
     * Get author name for an agent
     */
    public String getAuthorName(Long creatorId) {
        if (creatorId == null) return null;
        User user = userMapper.selectById(creatorId);
        return user != null ? user.getDisplayName() : null;
    }

    /**
     * Rate an agent (1-5 stars)
     */
    public void rateAgent(Long userId, Long agentId, Integer score) {
        if (score < 1 || score > 5) {
            throw new BusinessException(4000, "评分必须在 1-5 之间");
        }
        AgentRating existing = agentRatingMapper.selectOne(
                new QueryWrapper<AgentRating>()
                        .eq("user_id", userId)
                        .eq("agent_id", agentId));
        if (existing != null) {
            existing.setScore(score);
            agentRatingMapper.updateById(existing);
        } else {
            AgentRating rating = new AgentRating();
            rating.setUserId(userId);
            rating.setAgentId(agentId);
            rating.setScore(score);
            agentRatingMapper.insert(rating);
        }
    }

    /**
     * Get average rating for an agent
     */
    public Double getAverageRating(Long agentId) {
        List<AgentRating> ratings = agentRatingMapper.selectList(
                new QueryWrapper<AgentRating>().eq("agent_id", agentId));
        if (ratings.isEmpty()) return 0.0;
        return ratings.stream().mapToInt(AgentRating::getScore).average().orElse(0.0);
    }

    /**
     * Get rating count for an agent
     */
    public long getRatingCount(Long agentId) {
        return agentRatingMapper.selectCount(
                new QueryWrapper<AgentRating>().eq("agent_id", agentId));
    }

    /**
     * Add a comment to an agent
     */
    public AgentComment addComment(Long userId, Long agentId, String content) {
        AgentComment comment = new AgentComment();
        comment.setUserId(userId);
        comment.setAgentId(agentId);
        comment.setContent(content);
        agentCommentMapper.insert(comment);
        return comment;
    }

    /**
     * Get comments for an agent
     */
    public List<AgentComment> getComments(Long agentId) {
        return agentCommentMapper.selectList(
                new QueryWrapper<AgentComment>()
                        .eq("agent_id", agentId)
                        .orderByDesc("created_at"));
    }

    /**
     * List agents by category
     */
    public List<Agent> listByCategory(String category) {
        QueryWrapper<Agent> qw = new QueryWrapper<>();
        qw.eq("status", "PUBLISHED");
        if (category != null && !category.isEmpty()) {
            qw.eq("category", category);
        }
        qw.orderByDesc("published_at");
        return agentMapper.selectList(qw);
    }

    /**
     * Get recommended agents (by install count and rating)
     */
    public List<Agent> getRecommendedAgents(int limit) {
        List<Agent> agents = agentMapper.selectList(
                new QueryWrapper<Agent>().eq("status", "PUBLISHED"));

        // Sort by install count * rating score
        agents.sort((a, b) -> {
            double scoreA = getAgentScore(a.getId());
            double scoreB = getAgentScore(b.getId());
            return Double.compare(scoreB, scoreA);
        });

        return agents.subList(0, Math.min(limit, agents.size()));
    }

    /**
     * Get ranking agents (hot, new, top rated)
     */
    public List<Agent> getRankingAgents(String type, int limit) {
        QueryWrapper<Agent> qw = new QueryWrapper<>();
        qw.eq("status", "PUBLISHED");

        switch (type) {
            case "hot":
                // Sort by published_at as proxy for hot
                qw.orderByDesc("published_at");
                break;
            case "new":
                qw.orderByDesc("created_at");
                break;
            case "top":
                qw.orderByDesc("published_at");
                break;
            default:
                qw.orderByDesc("published_at");
        }

        List<Agent> agents = agentMapper.selectList(qw);
        return agents.subList(0, Math.min(limit, agents.size()));
    }

    /**
     * Get all categories
     */
    public List<String> getCategories() {
        List<Agent> agents = agentMapper.selectList(
                new QueryWrapper<Agent>().eq("status", "PUBLISHED").select("category"));
        Set<String> categories = new HashSet<>();
        for (Agent agent : agents) {
            if (agent.getCategory() != null && !agent.getCategory().isEmpty()) {
                categories.add(agent.getCategory());
            }
        }
        return new ArrayList<>(categories);
    }

    private double getAgentScore(Long agentId) {
        long installs = getInstallCount(agentId);
        double avgRating = getAverageRating(agentId);
        long ratingCount = getRatingCount(agentId);
        // Weighted score: installs * 0.4 + avgRating * ratingCount * 0.6
        return installs * 0.4 + avgRating * ratingCount * 0.6;
    }
}
