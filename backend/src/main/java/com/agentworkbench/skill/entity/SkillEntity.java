package com.agentworkbench.skill.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("skill")
public class SkillEntity {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String name;

    private String description;

    private String type;

    private String inputSchema;

    private String outputSchema;

    private String implClass;

    private Long creatorId;

    private String status;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
