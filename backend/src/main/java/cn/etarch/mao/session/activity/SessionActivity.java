package cn.etarch.mao.session.activity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("session_activity")
public class SessionActivity {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long sessionId;

    /** Activity type: EXPLORE|READ|EDIT|RUN|SEARCH|TOOL */
    private String type;

    /** Target: file path, command summary, etc. */
    private String target;

    /** Human-readable summary */
    private String summary;

    /** Full detail JSON */
    private String detailJson;

    /** Status: SUCCESS|ERROR|RUNNING */
    private String status;

    /** Duration in milliseconds */
    private Integer durationMs;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
