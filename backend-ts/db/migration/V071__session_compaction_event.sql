-- V071: 会话压缩事件历史（每次成功压缩一条，用于客户端时间线展示）

CREATE TABLE IF NOT EXISTS `session_compaction_event` (
    `id`                      BIGINT PRIMARY KEY AUTO_INCREMENT,
    `session_id`              BIGINT NOT NULL,
    `trigger_mode`            VARCHAR(32) NOT NULL COMMENT 'request_start | mid_loop',
    `prev_boundary_msg_id`    BIGINT NOT NULL DEFAULT 0 COMMENT '压缩前边界消息 ID',
    `boundary_msg_id`         BIGINT NOT NULL COMMENT '压缩后边界消息 ID（标记锚点）',
    `compacted_message_count` INT NOT NULL DEFAULT 0 COMMENT '本次摘要覆盖的消息条数',
    `summary_tokens`          INT NOT NULL DEFAULT 0,
    `saved_tokens`            INT NOT NULL DEFAULT 0,
    `duration_ms`             BIGINT NOT NULL DEFAULT 0,
    `compact_model`           VARCHAR(128) NULL,
    `created_at`              DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_session_boundary` (`session_id`, `boundary_msg_id`),
    INDEX `idx_session_created` (`session_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
