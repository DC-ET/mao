-- V136: 会话只读分享。登录态链接 expires_at 恒为 NULL；匿名 token 链接（默认关闭）写入过期时间。

CREATE TABLE IF NOT EXISTS `session_share` (
    `id`                BIGINT PRIMARY KEY AUTO_INCREMENT,
    `session_id`        BIGINT      NOT NULL,
    `share_token`       CHAR(64)    NOT NULL COMMENT '32 字节随机 hex',
    `message_watermark` BIGINT      NOT NULL DEFAULT 0 COMMENT '创建或刷新时的最大消息 id（水位，可回落）',
    `created_by`        BIGINT      NOT NULL,
    `view_count`        INT         NOT NULL DEFAULT 0,
    `last_viewed_at`    DATETIME    NULL,
    `expires_at`        DATETIME    NULL COMMENT '匿名 token 链接过期时间；登录链接恒为 NULL',
    `revoked_at`        DATETIME    NULL,
    `created_at`        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_share_token` (`share_token`),
    KEY `idx_share_session` (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='会话只读分享';

INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`, `is_secret`) VALUES
('share.tokenLinksEnabled', 'false', '分享', '匿名分享链接开关（默认关闭；开启后属主可生成带过期时间的免登录链接）', 1, 0);
