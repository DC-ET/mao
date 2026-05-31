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

    private String executionMode;

    private String workspace;

    /** Task phase: IDLE|RUNNING|WAITING_USER|WAITING_APPROVAL|COMPLETED|FAILED|CANCELLED */
    private String phase;

    /** One-line task summary */
    private String summary;

    /** When the current execution round started */
    private LocalDateTime startedAt;

    /** Accumulated execution time in milliseconds */
    private Long elapsedMs;

    /** Progress steps as JSON: [{id, label, done}] */
    private String stepsJson;

    /** Project key: workspace basename or user-defined project name */
    private String projectKey;

    /** Last activity timestamp */
    private LocalDateTime lastActivityAt;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
