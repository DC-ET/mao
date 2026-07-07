package cn.etarch.mao.session.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("message_queue")
public class MessageQueue {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long sessionId;

    private Long userId;

    private String content;

    private String images;

    private Integer sortOrder;

    private String status;

    @TableLogic
    private Integer deleted;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
