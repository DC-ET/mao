CREATE TABLE IF NOT EXISTS `feishu_progress_card` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `session_id` BIGINT NOT NULL COMMENT '会话ID(会话互斥，同一时刻仅一张活跃进度卡片)',
    `bot_id` BIGINT NOT NULL COMMENT '飞书Bot应用ID(feishu_bot.id)',
    `card_message_id` VARCHAR(128) NOT NULL COMMENT '进度卡片messageId',
    `chat_type` VARCHAR(16) NOT NULL COMMENT 'p2p/group/unknown',
    `chat_id` VARCHAR(64) NULL COMMENT '群chatId(group时)',
    `sender_open_id` VARCHAR(64) NULL COMMENT '触发任务的原发送者open_id(取消按钮鉴权)',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_feishu_progress_card_session` (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='飞书会话活跃进度卡片(崩溃恢复后续更)';
