package cn.etarch.mao.schedule.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("scheduled_task")
public class ScheduledTask {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    private Long agentId;

    private Long sessionId;

    private String name;

    private String prompt;

    private String cronExpression;

    /** ACTIVE / PAUSED */
    private String status;

    private LocalDateTime lastFireTime;

    /** COMPLETED / FAILED / SKIPPED */
    private String lastExecutionStatus;

    private LocalDateTime nextFireTime;

    private Integer fireCount;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
