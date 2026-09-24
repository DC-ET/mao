CREATE TABLE IF NOT EXISTS `dingtalk_bot` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `app_key`       VARCHAR(64)  NOT NULL COMMENT '内部唯一标识',
    `name`          VARCHAR(128) NOT NULL,
    `client_id`     VARCHAR(128) NOT NULL COMMENT 'Client ID / AppKey',
    `client_secret` VARCHAR(512) NOT NULL COMMENT 'AES-GCM',
    `robot_code`    VARCHAR(128) NOT NULL COMMENT '发送与下载使用，不假定等于 client_id',
    `agent_id`      BIGINT       NULL,
    `model_id`      BIGINT       NULL,
    `progress_card_template_id` VARCHAR(128) NULL,
    `queue_card_template_id`    VARCHAR(128) NULL,
    `enabled`       TINYINT      NOT NULL DEFAULT 1,
    `deleted`       TINYINT      NOT NULL DEFAULT 0,
    `created_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_dingtalk_bot_app_key` (`app_key`),
    UNIQUE KEY `uk_dingtalk_bot_client_id` (`client_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='钉钉企业内部机器人';

CREATE TABLE IF NOT EXISTS `dingtalk_binding` (
    `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`    BIGINT       NOT NULL,
    `union_id`   VARCHAR(128) NOT NULL,
    `userid`     VARCHAR(128) NOT NULL COMMENT '企业内 senderStaffId',
    `deleted`    TINYINT      NOT NULL DEFAULT 0,
    `active_union_id` VARCHAR(128) GENERATED ALWAYS AS (IF(`deleted` = 0, `union_id`, NULL)) STORED,
    `active_userid`   VARCHAR(128) GENERATED ALWAYS AS (IF(`deleted` = 0, `userid`, NULL)) STORED,
    `active_user_id`  BIGINT       GENERATED ALWAYS AS (IF(`deleted` = 0, `user_id`, NULL)) STORED,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_dingtalk_binding_union_active` (`active_union_id`),
    UNIQUE KEY `uk_dingtalk_binding_userid_active` (`active_userid`),
    UNIQUE KEY `uk_dingtalk_binding_user_active` (`active_user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='钉钉身份绑定';

CREATE TABLE IF NOT EXISTS `dingtalk_chat` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `bot_id`        BIGINT       NOT NULL,
    `conversation_id` VARCHAR(128) NOT NULL,
    `chat_type`     VARCHAR(16)  NOT NULL COMMENT 'p2p / group',
    `session_id`    BIGINT       NOT NULL,
    `owner_user_id` BIGINT       NOT NULL,
    `workspace`     VARCHAR(512) NULL,
    `title`         VARCHAR(128) NULL COMMENT '群标题快照，可空',
    `created_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_dingtalk_chat` (`bot_id`, `conversation_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='钉钉会话指针';

CREATE TABLE IF NOT EXISTS `dingtalk_chat_member` (
    `id`           BIGINT PRIMARY KEY AUTO_INCREMENT,
    `bot_id`       BIGINT       NOT NULL,
    `conversation_id` VARCHAR(128) NOT NULL,
    `user_id`      BIGINT       NOT NULL,
    `userid`       VARCHAR(128) NOT NULL,
    `display_name` VARCHAR(128) NULL,
    `created_at`   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_dingtalk_chat_member` (`bot_id`, `conversation_id`, `userid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='钉钉群成员登记';

CREATE TABLE IF NOT EXISTS `dingtalk_group_message_log` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `bot_id`      BIGINT       NOT NULL,
    `conversation_id` VARCHAR(128) NOT NULL,
    `sender_userid` VARCHAR(128) NOT NULL,
    `sender_name` VARCHAR(128) NOT NULL,
    `direction`   VARCHAR(8)   NOT NULL COMMENT 'IN / OUT',
    `content`     TEXT         NULL,
    `message_id`  VARCHAR(128) NULL,
    `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY `idx_dingtalk_group_log` (`bot_id`, `conversation_id`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='钉钉群内 @ 往来';

CREATE TABLE IF NOT EXISTS `dingtalk_inbound_event` (
    `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
    `bot_id`     BIGINT       NOT NULL,
    `message_id` VARCHAR(128) NOT NULL,
    `chat_id`    VARCHAR(128) NULL,
    `status`     VARCHAR(16)  NOT NULL COMMENT 'CLAIMED / DONE / FAILED',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_dingtalk_inbound_event` (`bot_id`, `message_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='钉钉入站去重';

CREATE TABLE IF NOT EXISTS `dingtalk_inbound_queue` (
    `id`              BIGINT PRIMARY KEY AUTO_INCREMENT,
    `bot_id`          BIGINT       NOT NULL,
    `session_id`      BIGINT       NOT NULL,
    `message_id`      VARCHAR(128) NOT NULL,
    `out_track_id`    VARCHAR(128) NULL COMMENT '排队卡实例 ID',
    `sender_userid`   VARCHAR(128) NOT NULL,
    `mao_user_id`     BIGINT       NULL,
    `rank_no`         BIGINT       NOT NULL,
    `status`          VARCHAR(16)  NOT NULL DEFAULT 'QUEUED',
    `payload`         MEDIUMTEXT   NOT NULL,
    `created_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_dingtalk_queue_message` (`bot_id`, `message_id`),
    KEY `idx_dingtalk_queue_session` (`session_id`, `status`, `rank_no`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='钉钉入站排队';

CREATE TABLE IF NOT EXISTS `dingtalk_progress_card` (
    `session_id`    BIGINT PRIMARY KEY,
    `bot_id`        BIGINT       NOT NULL,
    `out_track_id`  VARCHAR(128) NOT NULL,
    `chat_type`     VARCHAR(16)  NOT NULL,
    `conversation_id` VARCHAR(128) NULL,
    `sender_userid` VARCHAR(128) NULL,
    `created_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='钉钉进度卡映射';

CREATE TABLE IF NOT EXISTS `dingtalk_oauth_state` (
    `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
    `state`      VARCHAR(64)  NOT NULL,
    `user_id`    BIGINT       NULL COMMENT '设置页发起时已有；钉钉内发起时先空，登录后再填',
    `status`     VARCHAR(16)  NOT NULL,
    `expires_at` DATETIME     NOT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_dingtalk_oauth_state` (`state`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='钉钉绑定 OAuth state';

CREATE TABLE IF NOT EXISTS `dingtalk_pending_binding_message` (
    `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
    `state`      VARCHAR(64)  NOT NULL,
    `bot_id`     BIGINT       NOT NULL,
    `payload`    MEDIUMTEXT   NOT NULL,
    `status`     VARCHAR(16)  NOT NULL,
    `expires_at` DATETIME     NOT NULL,
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_dingtalk_pending_state` (`state`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='钉钉未绑定待重放消息';
