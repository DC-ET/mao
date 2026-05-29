-- Shell 会话管理表

CREATE TABLE IF NOT EXISTS `shell_session` (
    `id`              BIGINT PRIMARY KEY AUTO_INCREMENT,
    `session_id`      VARCHAR(64) NOT NULL UNIQUE COMMENT '会话唯一标识',
    `conversation_id` BIGINT NOT NULL COMMENT '关联的会话 ID',
    `pid`             INT COMMENT '进程 PID',
    `current_workdir` VARCHAR(512) COMMENT '当前工作目录',
    `status`          VARCHAR(20) DEFAULT 'ACTIVE' COMMENT 'ACTIVE/CLOSED/EXPIRED',
    `command_count`   INT DEFAULT 0 COMMENT '已执行命令数',
    `created_at`      DATETIME DEFAULT CURRENT_TIMESTAMP,
    `last_active_at`  DATETIME DEFAULT CURRENT_TIMESTAMP,
    `closed_at`       DATETIME,
    INDEX `idx_conversation` (`conversation_id`),
    INDEX `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `shell_command_log` (
    `id`              BIGINT PRIMARY KEY AUTO_INCREMENT,
    `session_id`      VARCHAR(64) NOT NULL COMMENT '会话 ID',
    `conversation_id` BIGINT NOT NULL COMMENT '会话 ID',
    `command`         TEXT NOT NULL COMMENT '执行的命令',
    `exit_code`       INT COMMENT '退出码',
    `output_lines`    INT COMMENT '输出行数',
    `output_file`     VARCHAR(512) COMMENT '输出文件路径',
    `truncated`       TINYINT DEFAULT 0 COMMENT '是否截断',
    `elapsed_ms`      INT COMMENT '执行耗时（毫秒）',
    `executed_at`     DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_session` (`session_id`),
    INDEX `idx_conversation` (`conversation_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
