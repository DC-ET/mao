package cn.etarch.mao.notification.task.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("task_notification_delivery")
public class TaskNotificationDelivery {
    @TableId(type = IdType.AUTO)
    private Long id;
    private String eventKey;
    private Long userId;
    private Long sessionId;
    private String executionId;
    private String terminalPhase;
    private String channel;
    private String webhookCiphertext;
    private String titleSnapshot;
    private String status;
    private Integer attemptCount;
    private LocalDateTime nextRetryAt;
    private Integer lastHttpStatus;
    private String lastProviderCode;
    private String lastError;
    private LocalDateTime sentAt;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
