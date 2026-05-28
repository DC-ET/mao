-- V014: 会话压缩摘要表 + llm_model 上下文窗口字段

CREATE TABLE IF NOT EXISTS `session_compaction` (
    `id`                      BIGINT PRIMARY KEY AUTO_INCREMENT,
    `session_id`              BIGINT NOT NULL UNIQUE,
    `summary_text`            MEDIUMTEXT COMMENT '当前生效的滚动摘要正文',
    `last_compacted_msg_id`   BIGINT DEFAULT 0 COMMENT '摘要已覆盖到的最后一条消息 ID',
    `compact_count`           INT DEFAULT 0 COMMENT '累计压缩次数',
    `input_tokens`            BIGINT DEFAULT 0 COMMENT '累计压缩输入 token',
    `output_tokens`           BIGINT DEFAULT 0 COMMENT '累计压缩输出 token',
    `compact_model`           VARCHAR(128) COMMENT '压缩使用的模型标识',
    `created_at`              DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`              DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_session` (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 为 llm_model 增加上下文窗口大小字段
DROP PROCEDURE IF EXISTS add_context_window_tokens;
DELIMITER //
CREATE PROCEDURE add_context_window_tokens()
BEGIN
    IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'llm_model' AND COLUMN_NAME = 'context_window_tokens') THEN
        ALTER TABLE `llm_model` ADD COLUMN `context_window_tokens` INT DEFAULT NULL COMMENT '模型上下文窗口大小（token），用于压缩触发判定';
    END IF;
END //
DELIMITER ;
CALL add_context_window_tokens();
DROP PROCEDURE add_context_window_tokens;
