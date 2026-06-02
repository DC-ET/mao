package com.agentworkbench.harness.tool;

import java.util.Map;

/**
 * Tool 接口 - 所有可执行工具都实现此接口
 */
public interface Tool {

    /**
     * Tool 名称（唯一标识）
     */
    String getName();

    /**
     * Tool 描述
     */
    String getDescription();

    /**
     * 输入参数 JSON Schema
     */
    Map<String, Object> getInputSchema();

    /**
     * 输出参数 JSON Schema
     */
    Map<String, Object> getOutputSchema();

    /**
     * 工具行为指南（Markdown 格式）
     * 包含触发条件、状态机、few-shot 示例等，注入到 system prompt 中
     * 默认返回 null 表示无额外行为指南
     */
    default String getToolPrompt() { return null; }

    /**
     * 执行 Tool
     *
     * @param arguments JSON 格式的参数
     * @return 执行结果
     */
    String execute(String arguments);

    /**
     * 执行 Tool（带会话工作空间上下文）
     * 默认实现忽略 workspace，子类可覆盖以使用会话工作空间
     *
     * @param arguments JSON 格式的参数
     * @param workspace 会话工作空间目录路径（可能为 null）
     * @return 执行结果
     */
    default String execute(String arguments, String workspace) {
        return execute(arguments);
    }

    /**
     * 执行 Tool（带会话 ID 和工作空间上下文）
     * 默认实现忽略 sessionId，子类可覆盖以使用会话 ID
     *
     * @param arguments JSON 格式的参数
     * @param sessionId 当前会话 ID（可能为 null）
     * @param workspace 会话工作空间目录路径（可能为 null）
     * @return 执行结果
     */
    default String execute(String arguments, Long sessionId, String workspace) {
        return execute(arguments, workspace);
    }
}
