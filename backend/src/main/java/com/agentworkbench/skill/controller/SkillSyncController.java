package com.agentworkbench.skill.controller;

import com.agentworkbench.agent.entity.Agent;
import com.agentworkbench.agent.mapper.AgentMapper;
import com.agentworkbench.common.exception.BusinessException;
import com.agentworkbench.common.result.ErrorCode;
import com.agentworkbench.harness.skill.SkillSyncService;
import com.agentworkbench.session.entity.Session;
import com.agentworkbench.session.service.SessionService;
import jakarta.servlet.http.HttpServletResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

/**
 * REST API for skill sync package download (LOCAL mode).
 */
@RestController
@RequestMapping("/v1/skills")
@RequiredArgsConstructor
public class SkillSyncController {

    private final SkillSyncService skillSyncService;
    private final SessionService sessionService;
    private final AgentMapper agentMapper;

    @PostMapping("/sync-package")
    public void downloadSyncPackage(
            @RequestParam Long sessionId,
            HttpServletResponse response) throws Exception {
        Session session = sessionService.getSession(sessionId);
        Agent agent = agentMapper.selectById(session.getAgentId());
        if (agent == null) {
            throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
        }

        response.setStatus(HttpServletResponse.SC_OK);
        response.setContentType("application/zip");
        response.setHeader("Content-Disposition", "attachment; filename=\"skills.zip\"");

        skillSyncService.writeSyncZip(agent, sessionId, response.getOutputStream(), session.getUserId());
        response.getOutputStream().flush();
    }
}
