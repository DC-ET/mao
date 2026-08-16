CREATE TABLE IF NOT EXISTS `feishu_oauth_state` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `state` VARCHAR(64) NOT NULL COMMENT 'OAuth state',
    `status` VARCHAR(20) NOT NULL COMMENT 'PENDING / SUCCESS / FAILED / EXPIRED',
    `user_id` BIGINT NULL COMMENT '登录成功后的用户 ID',
    `error_message` VARCHAR(512) NULL COMMENT '失败原因',
    `expires_at` DATETIME NOT NULL COMMENT '过期时间',
    `consumed_at` DATETIME NULL COMMENT '客户端消费成功时间',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_feishu_oauth_state` (`state`),
    KEY `idx_feishu_oauth_state_status` (`status`),
    KEY `idx_feishu_oauth_state_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='飞书扫码登录 OAuth state';
