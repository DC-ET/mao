package com.agentworkbench.harness.skill;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.Map;

/**
 * Skill 调度器
 * 解析 LLM 返回的工具调用意图，调度对应的 Skill 执行
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class SkillDispatcher {

    private final SkillRegistry skillRegistry;

    /**
     * 执行工具调用
     *
     * @param toolName  工具名称
     * @param arguments JSON 格式的参数
     * @return 执行结果
     */
    public String dispatch(String toolName, String arguments) {
        log.debug("Dispatching tool call: {}", toolName);

        // 1. Try built-in skills first
        Skill skill = skillRegistry.getSkill(toolName);
        if (skill != null) {
            return skill.execute(arguments);
        }

        // 2. Try MCP tools (handled by McpClient)
        // TODO: Check if toolName belongs to an MCP server

        throw new IllegalArgumentException("Unknown tool: " + toolName);
    }
}
