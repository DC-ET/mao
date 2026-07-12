package cn.etarch.mao.harness.delegate;

import lombok.Builder;
import lombok.Data;

import java.util.List;

/**
 * 子智能体类型定义。每种类型有不同的 prompt、工具集和行为约束。
 */
@Data
@Builder
public class AgentDefinition {

    /** 类型标识，如 "researcher", "reviewer" */
    private String name;

    /** 描述，展示在工具 schema 中 */
    private String description;

    /** system prompt 覆盖，null 时继承父 Agent 的 prompt */
    private String systemPromptOverride;

    /** 最大轮次覆盖，null 时继承父 Agent 的设置 */
    private Integer maxRounds;

    /** 工具白名单，null 时表示使用父 Agent 全部工具（排除 delegate） */
    private List<String> allowedToolNames;

    /** 额外排除的工具列表（在默认排除 delegate 之外） */
    private List<String> excludedToolNames;
}
