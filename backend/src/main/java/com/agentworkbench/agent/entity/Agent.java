package com.agentworkbench.agent.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("agent")
public class Agent {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String name;

    private String description;

    private String systemPrompt;

    private Long modelId;

    private Long creatorId;

    private String configJson;

    /** 该 Agent 可用的 Skill 知识文档名称列表（JSON 数组），为空则加载全部 */
    private String skillNames;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
