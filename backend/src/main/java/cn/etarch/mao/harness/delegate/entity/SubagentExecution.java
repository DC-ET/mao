package cn.etarch.mao.harness.delegate.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("subagent_execution")
public class SubagentExecution {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long parentSessionId;

    private Long childSessionId;

    private String taskDescription;

    private String result;

    /** RUNNING / COMPLETED / FAILED / CANCELLED */
    private String status;

    private Integer totalRounds;

    private Integer totalPromptTokens;

    private Integer totalCompletionTokens;

    private LocalDateTime startedAt;

    private LocalDateTime completedAt;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
