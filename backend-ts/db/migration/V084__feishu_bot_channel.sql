CREATE TABLE IF NOT EXISTS `feishu_bot` (
    `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
    `app_key` VARCHAR(64) NOT NULL COMMENT '内部唯一标识',
    `name` VARCHAR(128) NOT NULL COMMENT '机器人显示名称',
    `app_id` VARCHAR(128) NOT NULL COMMENT '飞书应用 app_id',
    `app_secret` VARCHAR(512) NOT NULL COMMENT 'AES-GCM 加密存储',
    `agent_id` BIGINT NULL,
    `model_id` BIGINT NULL,
    `enabled` TINYINT NOT NULL DEFAULT 1,
    `deleted` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_feishu_bot_app_key` (`app_key`),
    UNIQUE KEY `uk_feishu_bot_app_id` (`app_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='飞书机器人配置';

CREATE TABLE IF NOT EXISTS `feishu_binding` (
    `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `union_id` VARCHAR(128) NOT NULL,
    `open_id` VARCHAR(128) NULL,
    `user_id_fs` VARCHAR(128) NULL,
    `deleted` TINYINT NOT NULL DEFAULT 0,
    `active_union_id` VARCHAR(128) GENERATED ALWAYS AS (IF(`deleted` = 0, `union_id`, NULL)) STORED,
    `active_user_id` BIGINT GENERATED ALWAYS AS (IF(`deleted` = 0, `user_id`, NULL)) STORED,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_feishu_binding_union_id_active` (`active_union_id`),
    UNIQUE KEY `uk_feishu_binding_user_id_active` (`active_user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='飞书用户绑定';

CREATE TABLE IF NOT EXISTS `feishu_chat` (
    `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
    `app_id` VARCHAR(128) NOT NULL,
    `chat_id` VARCHAR(128) NOT NULL,
    `session_id` BIGINT NOT NULL,
    `owner_user_id` BIGINT NOT NULL,
    `workspace` VARCHAR(512) NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_feishu_chat_app_chat` (`app_id`, `chat_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='飞书群会话映射';

CREATE TABLE IF NOT EXISTS `feishu_chat_member` (
    `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
    `app_id` VARCHAR(128) NOT NULL,
    `chat_id` VARCHAR(128) NOT NULL,
    `user_id` BIGINT NOT NULL,
    `open_id` VARCHAR(128) NOT NULL,
    `display_name` VARCHAR(128) NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_feishu_chat_member` (`app_id`, `chat_id`, `open_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='飞书群成员白名单';

CREATE TABLE IF NOT EXISTS `feishu_inbound_event` (
    `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
    `app_id` VARCHAR(128) NOT NULL,
    `message_id` VARCHAR(128) NOT NULL,
    `event_id` VARCHAR(128) NULL,
    `chat_id` VARCHAR(128) NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'CLAIMED',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_feishu_inbound_message` (`app_id`, `message_id`),
    KEY `idx_feishu_inbound_retry` (`status`, `updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='飞书入站消息幂等记录';

CREATE TABLE IF NOT EXISTS `feishu_group_message_log` (
    `id` BIGINT PRIMARY KEY AUTO_INCREMENT,
    `app_id` VARCHAR(128) NOT NULL,
    `chat_id` VARCHAR(128) NOT NULL,
    `sender_open_id` VARCHAR(128) NOT NULL,
    `sender_name` VARCHAR(128) NOT NULL,
    `msg_type` VARCHAR(32) NOT NULL DEFAULT 'text',
    `content` TEXT NULL,
    `file_key` VARCHAR(255) NULL,
    `message_id` VARCHAR(128) NOT NULL,
    `is_mention` TINYINT NOT NULL DEFAULT 0,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY `idx_feishu_group_message_time` (`app_id`, `chat_id`, `created_at`),
    UNIQUE KEY `uk_feishu_group_message_message` (`app_id`, `chat_id`, `message_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='飞书群聊消息日志';
