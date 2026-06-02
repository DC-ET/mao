package com.agentworkbench.harness.todo.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("session_todo")
public class SessionTodo {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long sessionId;

    private String content;

    private String description;

    private String activeForm;

    private String status;

    private Integer sortOrder;

    private String owner;

    private LocalDateTime claimedAt;

    private String blockedBy;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
