package cn.etarch.mao.session.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("session_compaction_event")
public class SessionCompactionEvent {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long sessionId;

    /** request_start | mid_loop */
    private String triggerMode;

    private Long prevBoundaryMsgId;

    private Long boundaryMsgId;

    private Integer compactedMessageCount;

    private Integer summaryTokens;

    private Integer savedTokens;

    private Long durationMs;

    private String compactModel;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
