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

    private String iconUrl;

    private String systemPrompt;

    private Long modelId;

    private Long creatorId;

    private String type;

    private String visibility;

    private String status;

    private Integer tokenLimit;

    private Integer maxRounds;

    private String configJson;

    private LocalDateTime publishedAt;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
