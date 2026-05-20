package com.agentworkbench.harness.skill;

import com.agentworkbench.harness.mcp.McpToolRegistry;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

@Slf4j
@Component
@RequiredArgsConstructor
public class SkillDispatcher {

    private final SkillRegistry skillRegistry;
    private final McpToolRegistry mcpToolRegistry;

    /**
     * Execute a tool call - routes to built-in Skill or MCP tool
     */
    public String dispatch(String toolName, String arguments) {
        log.debug("Dispatching tool call: {}", toolName);

        // 1. Try built-in skills
        Skill skill = skillRegistry.getSkill(toolName);
        if (skill != null) {
            log.debug("Routing to built-in skill: {}", toolName);
            return skill.execute(arguments);
        }

        // 2. Try MCP tools
        if (mcpToolRegistry.hasTool(toolName)) {
            log.debug("Routing to MCP tool: {}", toolName);
            return mcpToolRegistry.callTool(toolName, arguments);
        }

        throw new IllegalArgumentException("Unknown tool: " + toolName);
    }
}
