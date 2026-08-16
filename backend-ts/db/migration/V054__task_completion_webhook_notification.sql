CREATE TABLE IF NOT EXISTS `user_task_notification_preference` (
    `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
    `user_id` BIGINT NOT NULL COMMENT '用户 ID',
    `enabled` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否开启：0=关闭，1=开启',
    `channel` VARCHAR(16) NULL COMMENT '通知渠道：DINGTALK 或 FEISHU',
    `webhook_ciphertext` VARCHAR(4096) NULL COMMENT 'AES-256-GCM 加密后的 Webhook URL',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_user_task_notification_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户任务完成通知偏好';

CREATE TABLE IF NOT EXISTS `task_notification_delivery` (
    `id` BIGINT NOT NULL AUTO_INCREMENT COMMENT '主键 ID',
    `event_key` VARCHAR(160) NOT NULL COMMENT '任务执行轮次与终态组成的幂等键',
    `user_id` BIGINT NOT NULL COMMENT '用户 ID',
    `session_id` BIGINT NOT NULL COMMENT '会话 ID',
    `execution_id` VARCHAR(64) NOT NULL COMMENT '任务执行轮次 ID',
    `terminal_phase` VARCHAR(16) NOT NULL COMMENT '任务终态：COMPLETED 或 FAILED',
    `channel` VARCHAR(16) NOT NULL COMMENT '通知渠道：DINGTALK 或 FEISHU',
    `webhook_ciphertext` VARCHAR(4096) NOT NULL COMMENT '事件创建时的 Webhook 密文快照',
    `title_snapshot` VARCHAR(255) NOT NULL COMMENT '任务标题快照',
    `status` VARCHAR(24) NOT NULL COMMENT 'WAITING_WS/PENDING/SENDING/SUCCEEDED/FAILED/SUPPRESSED_WS',
    `attempt_count` INT NOT NULL DEFAULT 0 COMMENT '已发送次数',
    `next_retry_at` DATETIME NULL COMMENT '下次重试时间',
    `last_http_status` INT NULL COMMENT '最近一次 HTTP 状态码',
    `last_provider_code` VARCHAR(64) NULL COMMENT '最近一次平台业务码',
    `last_error` VARCHAR(1000) NULL COMMENT '最近一次脱敏错误摘要',
    `sent_at` DATETIME NULL COMMENT '发送成功时间',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_task_notification_event` (`event_key`),
    KEY `idx_task_notification_pending` (`status`, `next_retry_at`),
    KEY `idx_task_notification_session` (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='任务完成 Webhook 投递记录';
