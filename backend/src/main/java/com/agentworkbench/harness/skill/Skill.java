package com.agentworkbench.harness.skill;

import java.util.Map;

/**
 * Skill 接口 - 所有内置 Skill 都实现此接口
 */
public interface Skill {

    /**
     * Skill 名称（唯一标识）
     */
    String getName();

    /**
     * Skill 描述
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
     * 执行 Skill
     *
     * @param arguments JSON 格式的参数
     * @return 执行结果
     */
    String execute(String arguments);
}
