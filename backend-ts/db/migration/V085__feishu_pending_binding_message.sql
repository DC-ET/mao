CREATE TABLE IF NOT EXISTS `feishu_pending_binding_message` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `state` VARCHAR(64) NOT NULL,
    `app_id` BIGINT NOT NULL,
    `message_id` VARCHAR(128) NOT NULL,
    `card_message_id` VARCHAR(128) NULL,
    `event_json` JSON NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING/SENT/CLAIMED/COMPLETED/FAILED',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_feishu_pending_binding_state` (`state`),
    KEY `idx_feishu_pending_binding_status` (`status`, `updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='飞书待绑定并续处理消息';