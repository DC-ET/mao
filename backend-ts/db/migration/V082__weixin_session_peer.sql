-- 微信会话对端持久化：重启后仍能按 session 找到正确的 wx_user_id，避免多联系人账号发错人。

CREATE TABLE IF NOT EXISTS `weixin_session_peer` (
    `session_id` BIGINT NOT NULL COMMENT '会话ID',
    `wx_user_id` VARCHAR(128) NOT NULL COMMENT '微信侧用户ID',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='微信Bot会话对端绑定';
