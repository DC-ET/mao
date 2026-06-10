package com.agentworkbench.session.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("message_file_change")
public class FileChange {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long messageId;

    private Long sessionId;

    private String filePath;

    private String changeType;

    private Integer linesAdded;

    private Integer linesDeleted;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
