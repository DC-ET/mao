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
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
@RequiredArgsConstructor
public class SessionService {

    private final SessionMapper sessionMapper;
    private final MessageMapper messageMapper;
    private final AgentMapper agentMapper;

    public Session createSession(Long userId, Long agentId, String title) {
        Agent agent = agentMapper.selectById(agentId);
        if (agent == null) {
            throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
        }

        Session session = new Session();
        session.setUserId(userId);
        session.setAgentId(agentId);
        session.setTitle(title != null ? title : agent.getName());
        session.setStatus("ACTIVE");
        session.setIsPinned(0);
        session.setIsFavorite(0);
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
        if ("USER".equals(role) && session != null && session.getTitle() != null
                && session.getTitle().equals(agentMapper.selectById(session.getAgentId()).getName())) {
            String autoTitle = content.length() > 50 ? content.substring(0, 50) + "..." : content;
            session.setTitle(autoTitle);
            sessionMapper.updateById(session);
        }

        return message;
    }

    public List<Message> getMessages(Long sessionId) {
        return messageMapper.selectList(
                new QueryWrapper<Message>()
                        .eq("session_id", sessionId)
                        .orderByAsc("created_at"));
    }
}
