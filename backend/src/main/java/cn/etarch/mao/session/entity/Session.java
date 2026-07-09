package cn.etarch.mao.session.entity;

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

    /** LOCAL mode tool permission: READ_ONLY|READ_WRITE|SMART|FULL */
    private String permissionLevel;

    /** Current model for this session, NULL means use default model */
    private Long modelId;

    /** Whether the execution workspace is inside a git repository */
    private Boolean isGit;

    /** Execution platform: darwin|linux|win32 */
    private String platform;

    /** Shell path/name for the execution environment */
    private String shellPath;

    /** OS version, similar to uname -sr */
    private String osVersion;

    /** Task phase: IDLE|RUNNING|RESUMING|WAITING_APPROVAL|COMPLETED|FAILED|CANCELLED */
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

    /** Estimated context tokens from the most recent LLM call */
    private Integer contextTokens;

    /** Unread mark: 0=read, 1=unread (background completion) */
    private Integer unread;

    /** Parent session ID for sub-agent sessions; null for top-level sessions */
    private Long parentSessionId;

    /** Session type: NORMAL or SUBAGENT */
    private String sessionType;

    /** Logical deletion flag: 0=normal, 1=deleted */
    @TableLogic
    private Integer deleted;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
