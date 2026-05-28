package com.agentworkbench.session.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("session_compaction")
public class SessionCompaction {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long sessionId;

    private String summaryText;

    private Long lastCompactedMsgId;

    private Integer compactCount;

    private Long inputTokens;

    private Long outputTokens;

    private String compactModel;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
