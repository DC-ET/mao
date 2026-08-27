CREATE TABLE IF NOT EXISTS `feishu_inbound_queue` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `bot_id` BIGINT NOT NULL COMMENT '飞书Bot应用ID(feishu_bot.id)',
    `session_id` BIGINT NOT NULL COMMENT '所属会话ID',
    `message_id` VARCHAR(128) NOT NULL COMMENT '飞书原始消息messageId',
    `card_message_id` VARCHAR(128) NULL COMMENT '排队交互卡片messageId(按钮定位键)',
    `sender_open_id` VARCHAR(64) NOT NULL COMMENT '原消息发送者open_id(按钮鉴权)',
    `mao_user_id` BIGINT NULL COMMENT '绑定的mao用户ID(executionUserId)',
    `rank_no` BIGINT NOT NULL COMMENT '消费排序号(会话内越小越先)',
    `status` VARCHAR(16) NOT NULL DEFAULT 'QUEUED' COMMENT 'QUEUED/RUNNING/CANCELLED',
    `payload` MEDIUMTEXT NOT NULL COMMENT 'buildMessage产物+入站上下文快照(JSON)',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_bot_message` (`bot_id`, `message_id`),
    KEY `idx_session_status_rank` (`session_id`, `status`, `rank_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='飞书入站任务队列';
