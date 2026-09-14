INSERT INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`, `is_secret`) VALUES
('auth.ecp.config', '{"enabled":false,"appCode":"EK6301","baseUrl":"https://ecp.acg.team/api/v1","loginVariant":"PARTNER","timeoutMs":10000,"desktopCallbackUrl":"https://mao.etarch.cn/auth/ecp/feishu-callback","adminCallbackUrl":"https://mao.etarch.cn/admin/auth/ecp/feishu-callback"}', '集成配置', 'ECP 原生飞书登录 JSON 配置（开启后关闭其它登录方式）', 1, 0);

CREATE TABLE `ecp_oauth_state` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `state` VARCHAR(64) NOT NULL COMMENT 'OAuth state',
    `callback_target` VARCHAR(16) NOT NULL COMMENT 'desktop / admin',
    `status` VARCHAR(20) NOT NULL COMMENT 'PENDING / SUCCESS / FAILED / EXPIRED',
    `user_id` BIGINT NULL COMMENT '登录成功后的用户 ID',
    `error_message` VARCHAR(512) NULL COMMENT '失败原因',
    `expires_at` DATETIME NOT NULL COMMENT '过期时间',
    `consumed_at` DATETIME NULL COMMENT '客户端消费成功时间',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_ecp_oauth_state` (`state`),
    KEY `idx_ecp_oauth_state_status` (`status`),
    KEY `idx_ecp_oauth_state_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='ECP 飞书 OAuth state';

CREATE TABLE `user_ecp_session` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `session_token_enc` TEXT NOT NULL COMMENT 'AES-GCM 加密的 ECP sessionToken',
    `expires_at` DATETIME NOT NULL COMMENT 'ECP 票过期时间',
    `renew_status` VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE / RENEWING / FAILED',
    `last_renew_at` DATETIME NULL COMMENT '上次 renew 成功时间',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_user_ecp_session_user` (`user_id`),
    CONSTRAINT `fk_user_ecp_session_user` FOREIGN KEY (`user_id`) REFERENCES `user` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户 ECP sessionToken（加密存储）';
