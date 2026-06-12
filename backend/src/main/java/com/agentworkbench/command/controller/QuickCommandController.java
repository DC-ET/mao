package com.agentworkbench.command.controller;

import com.agentworkbench.agent.entity.Agent;
import com.agentworkbench.agent.service.AgentService;
import com.agentworkbench.command.entity.UserCommand;
import com.agentworkbench.command.service.UserCommandService;
import com.agentworkbench.common.result.Result;
import com.agentworkbench.harness.skill.SkillDocument;
import com.agentworkbench.harness.skill.SkillLoader;
import com.agentworkbench.harness.skill.SkillSyncService;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.Data;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;

import java.util.*;
import java.util.stream.Collectors;

@Slf4j
@RestController
@RequestMapping("/v1/quick-commands")
@RequiredArgsConstructor
public class QuickCommandController {

    private final SkillLoader skillLoader;
    private final SkillSyncService skillSyncService;
    private final UserCommandService userCommandService;
    private final AgentService agentService;
    private final ObjectMapper objectMapper;

    @GetMapping
    public Result<QuickCommandsVO> list(@AuthenticationPrincipal Long userId,
                                        @RequestParam(required = false) Long agentId) {
        // 1. Collect system skills (filtered by agent if agentId provided)
        List<String> agentSkillNames = null;
        if (agentId != null) {
            agentSkillNames = resolveAgentSkillNames(agentId);
        }

        List<QuickCommandItem> skills = new ArrayList<>();
        Set<String> seenNames = new HashSet<>();

        // System skills
        for (SkillDocument doc : skillLoader.getAllDocuments()) {
            if (agentSkillNames != null && !agentSkillNames.contains(doc.getName())) {
                continue;
            }
            if (!seenNames.contains(doc.getName())) {
                skills.add(new QuickCommandItem("skill", doc.getName(),
                        doc.getDescription() != null ? doc.getDescription() : ""));
                seenNames.add(doc.getName());
            }
        }

        // User skills (override system skills on name conflict)
        List<SkillDocument> userDocs = skillSyncService.getUserSkillDocuments(userId);
        for (SkillDocument doc : userDocs) {
            if (seenNames.contains(doc.getName())) {
                skills.removeIf(s -> s.getName().equals(doc.getName()));
            }
            skills.add(new QuickCommandItem("skill", doc.getName(),
                    doc.getDescription() != null ? doc.getDescription() : ""));
            seenNames.add(doc.getName());
        }

        // 2. Collect user commands
        List<UserCommand> commands = userCommandService.listByUserId(userId);
        List<QuickCommandItem> commandItems = commands.stream()
                .map(c -> new QuickCommandItem("command", c.getName(), ""))
                .collect(Collectors.toList());

        // 3. Build response
        QuickCommandsVO vo = new QuickCommandsVO();
        vo.setSkills(skills);
        vo.setCommands(commandItems);
        return Result.ok(vo);
    }

    private List<String> resolveAgentSkillNames(Long agentId) {
        try {
            Agent agent = agentService.getAgent(agentId);
            if (agent.getSkillNames() != null && !agent.getSkillNames().isBlank()) {
                return objectMapper.readValue(agent.getSkillNames(),
                        new TypeReference<List<String>>() {});
            }
        } catch (Exception e) {
            log.warn("Failed to resolve skill names for agent {}: {}", agentId, e.getMessage());
        }
        return null;
    }

    @Data
    public static class QuickCommandsVO {
        private List<QuickCommandItem> skills;
        private List<QuickCommandItem> commands;
    }

    @Data
    public static class QuickCommandItem {
        private final String type;
        private final String name;
        private final String description;
    }
}
