package com.agentworkbench.session.service;

import com.agentworkbench.agent.entity.Agent;
import com.agentworkbench.agent.mapper.AgentMapper;
import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.agentworkbench.session.entity.Message;
import com.agentworkbench.session.entity.Session;
import com.agentworkbench.session.mapper.MessageMapper;
import com.agentworkbench.session.mapper.SessionMapper;
import com.baomidou.mybatisplus.core.conditions.query.QueryWrapper;
import com.baomidou.mybatisplus.core.conditions.update.UpdateWrapper;
import lombok.RequiredArgsConstructor;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.agentworkbench.session.util.TitleGenerator;
import lombok.extern.slf4j.Slf4j;

import java.time.LocalDateTime;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

@Slf4j
@Service
@RequiredArgsConstructor
public class SessionService {

    /** Stale threshold: sessions RUNNING longer than this are swept to FAILED */
    private static final int STALE_MINUTES = 10;

    private final SessionMapper sessionMapper;
    private final MessageMapper messageMapper;
    private final AgentMapper agentMapper;

    public Session createSession(Long userId, Long agentId, String title) {
        return createSession(userId, agentId, title, "CLOUD");
    }

    public Session createSession(Long userId, Long agentId, String title, String executionMode) {
        return createSession(userId, agentId, title, executionMode, null);
    }

    public Session createSession(Long userId, Long agentId, String title, String executionMode, String workspace) {
        Agent agent = agentMapper.selectById(agentId);
        if (agent == null) {
            throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
        }

        Session session = new Session();
        session.setUserId(userId);
        session.setAgentId(agentId);
        session.setTitle(title != null ? title : agent.getName());
        session.setStatus("ACTIVE");
        session.setExecutionMode(executionMode != null ? executionMode : "CLOUD");
        session.setWorkspace(workspace);
        session.setIsPinned(0);
        session.setIsFavorite(0);
        session.setPhase("IDLE");
        session.setElapsedMs(0L);
        session.setProjectKey(deriveProjectKey(workspace));
        sessionMapper.insert(session);
        return session;
    }

    public List<Session> listSessions(Long userId, String keyword, String status) {
        QueryWrapper<Session> qw = new QueryWrapper<>();
        qw.eq("user_id", userId);
        if (keyword != null && !keyword.isEmpty()) {
            qw.and(w -> w.like("title", keyword));
        }
        if (status != null && !status.isEmpty()) {
            qw.eq("status", status);
        } else {
            qw.eq("status", "ACTIVE");
        }
        qw.orderByDesc("is_pinned").orderByDesc("updated_at");
        return sessionMapper.selectList(qw);
    }

    public Session getSession(Long id) {
        Session session = sessionMapper.selectById(id);
        if (session == null) {
            throw new BusinessException(ErrorCode.SESSION_NOT_FOUND);
        }
        return session;
    }

    @Transactional
    public void deleteSession(Long id) {
        messageMapper.delete(new QueryWrapper<Message>().eq("session_id", id));
        sessionMapper.deleteById(id);
    }

    public void togglePin(Long id) {
        Session session = getSession(id);
        session.setIsPinned(session.getIsPinned() != null && session.getIsPinned() == 1 ? 0 : 1);
        sessionMapper.updateById(session);
    }

    public void toggleFavorite(Long id) {
        Session session = getSession(id);
        session.setIsFavorite(session.getIsFavorite() != null && session.getIsFavorite() == 1 ? 0 : 1);
        sessionMapper.updateById(session);
    }

    public void archiveSession(Long id) {
        Session session = getSession(id);
        session.setStatus("ARCHIVED");
        sessionMapper.updateById(session);
    }

    public Message saveMessage(Long sessionId, String role, String content,
                                String toolCallId, String toolCalls,
                                Integer tokenCount, Long modelId) {
        Message message = new Message();
        message.setSessionId(sessionId);
        message.setRole(role);
        message.setContent(content);
        message.setToolCallId(toolCallId);
        message.setToolCalls(toolCalls);
        message.setTokenCount(tokenCount != null ? tokenCount : 0);
        message.setModelId(modelId);
        messageMapper.insert(message);

        // Update session's updated_at
        Session session = sessionMapper.selectById(sessionId);
        if (session != null) {
            sessionMapper.updateById(session);
        }

        // Auto-generate title from first user message
        if ("USER".equals(role) && session != null) {
            Agent agent = agentMapper.selectById(session.getAgentId());
            String agentName = agent != null ? agent.getName() : null;
            if (session.getTitle() != null && (session.getTitle().equals(agentName) || session.getTitle().isBlank())) {
                String autoTitle = TitleGenerator.generate(content);
                if (autoTitle != null) {
                    session.setTitle(autoTitle);
                    sessionMapper.updateById(session);
                }
            }
        }

        return message;
    }

    public List<Message> getMessages(Long sessionId) {
        return messageMapper.selectList(
                new QueryWrapper<Message>()
                        .eq("session_id", sessionId)
                        .orderByAsc("created_at"));
    }

    // --- Phase management ---

    public void updatePhase(Long sessionId, String phase) {
        Session session = getSession(sessionId);
        session.setPhase(phase);
        session.setLastActivityAt(LocalDateTime.now());

        if ("RUNNING".equals(phase)) {
            session.setStartedAt(LocalDateTime.now());
        } else if ("IDLE".equals(phase) || "COMPLETED".equals(phase) || "FAILED".equals(phase) || "CANCELLED".equals(phase)) {
            // Accumulate elapsed time
            if (session.getStartedAt() != null) {
                long elapsed = java.time.Duration.between(session.getStartedAt(), LocalDateTime.now()).toMillis();
                session.setElapsedMs((session.getElapsedMs() != null ? session.getElapsedMs() : 0) + elapsed);
                session.setStartedAt(null);
            }
        }

        sessionMapper.updateById(session);
    }

    public void updateSummary(Long sessionId, String summary) {
        Session session = getSession(sessionId);
        session.setSummary(summary);
        sessionMapper.updateById(session);
    }

    public void updateProjectKey(Long sessionId, String projectKey) {
        Session session = getSession(sessionId);
        session.setProjectKey(projectKey);
        sessionMapper.updateById(session);
    }

    public void updateTitle(Long sessionId, String title) {
        Session session = getSession(sessionId);
        session.setTitle(title);
        sessionMapper.updateById(session);
    }

    public Map<String, List<Session>> listSessionsForDashboard(Long userId) {
        Map<String, List<Session>> result = new java.util.HashMap<>();

        // Running / waiting sessions
        QueryWrapper<Session> runningQw = new QueryWrapper<>();
        runningQw.eq("user_id", userId)
                .eq("status", "ACTIVE")
                .in("phase", Arrays.asList("RUNNING", "WAITING_USER", "WAITING_APPROVAL"))
                .orderByDesc("last_activity_at");
        result.put("running", sessionMapper.selectList(runningQw));

        // Recent sessions (not running)
        QueryWrapper<Session> recentQw = new QueryWrapper<>();
        recentQw.eq("user_id", userId)
                .eq("status", "ACTIVE")
                .notIn("phase", Arrays.asList("RUNNING", "WAITING_USER", "WAITING_APPROVAL"))
                .orderByDesc("updated_at")
                .last("LIMIT 20");
        result.put("recent", sessionMapper.selectList(recentQw));

        return result;
    }

    /**
     * Sweep sessions stuck in RUNNING phase beyond the stale threshold.
     * Runs every 60 seconds to catch orphaned sessions from crashes, network drops, etc.
     */
    @Scheduled(fixedRate = 60_000)
    public void sweepStaleRunningSessions() {
        LocalDateTime threshold = LocalDateTime.now().minusMinutes(STALE_MINUTES);
        log.debug("Sweeping stale RUNNING sessions older than {}", threshold);
        UpdateWrapper<Session> uw = new UpdateWrapper<>();
        uw.eq("phase", "RUNNING")
          .and(w -> w.lt("last_activity_at", threshold)
                     .or()
                     .isNull("last_activity_at"));
        Session update = new Session();
        update.setPhase("FAILED");
        int affected = sessionMapper.update(update, uw);
        if (affected > 0) {
            log.warn("Swept {} stale RUNNING sessions to FAILED (no activity for {}min)", affected, STALE_MINUTES);
        }
    }

    /** Derive project_key from workspace path (last segment) */
    public static String deriveProjectKey(String workspace) {
        if (workspace == null || workspace.isBlank()) return null;
        String normalized = workspace.replace("\\", "/");
        String[] parts = normalized.split("/");
        for (int i = parts.length - 1; i >= 0; i--) {
            if (!parts[i].isEmpty()) return parts[i];
        }
        return null;
    }
}
