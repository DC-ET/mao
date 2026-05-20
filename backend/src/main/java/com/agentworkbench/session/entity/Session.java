package com.agentworkbench.session.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("session")
public class Session {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    private Long agentId;

    private String title;

    private String status;

    private Integer isPinned;

    private Integer isFavorite;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
