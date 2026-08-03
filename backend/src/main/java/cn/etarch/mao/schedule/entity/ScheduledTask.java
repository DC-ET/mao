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

    /** 是否已执行完结：1=已完结(不再自动触发)，0=进行中 */
    private Integer finished;

    /** 完结时间 */
    private LocalDateTime finishedAt;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;

    @TableLogic
    private Integer deleted;
}
