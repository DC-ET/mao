-- 开放 API：个人 API Token + 入站 Webhook 触发器 + 出站事件订阅（docs/plan/2026-10-05-open-api-webhook-technical-design.md §5.1）。
-- message_queue 增加来源两列，类比 V108 的 scheduled_task_id 绑定：入队时落列，
-- 队列消费侧凭 open_trigger_id 回写触发器连续失败计数（source_type 供收件箱来源透传）。

CREATE TABLE IF NOT EXISTS `api_token` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`       BIGINT NOT NULL,
    `name`          VARCHAR(128) NOT NULL,
    `token_prefix`  VARCHAR(16)  NOT NULL COMMENT '明文前 12 位（mao_ + 8 位），列表展示用',
    `token_hash`    CHAR(64)     NOT NULL COMMENT 'sha256(明文)，明文不落库',
    `scopes`        VARCHAR(1024) NOT NULL DEFAULT '[]' COMMENT 'JSON 数组，openapi 域自有 scope 字典（首期仅 open:run），不进 permission 目录',
    `expires_at`    DATETIME NULL,
    `revoked_at`    DATETIME NULL,
    `last_used_at`  DATETIME NULL,
    `created_at`    DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_api_token_hash` (`token_hash`),
    KEY `idx_api_token_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='开放 API 个人 Token';

CREATE TABLE IF NOT EXISTS `webhook_trigger` (
    `id`                    BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`               BIGINT NOT NULL,
    `agent_id`              BIGINT NOT NULL,
    `session_id`            BIGINT NULL COMMENT 'NULL=每次触发新建会话',
    `name`                  VARCHAR(128) NOT NULL,
    `path_token`            CHAR(32) NOT NULL COMMENT 'URL 路径随机段（128bit hex），防枚举',
    `secret_cipher`         TEXT NOT NULL COMMENT 'HMAC key，AES-GCM 加密存储（密钥同通知渠道，可用 APP_NOTIFICATION_WEBHOOK_SECRET 覆盖默认）',
    `enabled`               TINYINT(1) NOT NULL DEFAULT 1 COMMENT '创建即启用（技术方案决策 9）',
    `consecutive_failures`  INT NOT NULL DEFAULT 0 COMMENT '连续失败计数，FAILED +1 / COMPLETED 清零 / CANCELLED 与启停重置不计',
    `last_fired_at`         DATETIME NULL,
    `created_at`            DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`            DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_webhook_trigger_path` (`path_token`),
    KEY `idx_webhook_trigger_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='入站 Webhook 触发器';

ALTER TABLE `message_queue`
    ADD COLUMN `source_type`     VARCHAR(16) NULL DEFAULT NULL COMMENT 'SCHEDULED/WEBHOOK/API，NULL=普通入队',
    ADD COLUMN `open_trigger_id` BIGINT NULL DEFAULT NULL COMMENT 'WEBHOOK 来源时的触发器绑定（类比 scheduled_task_id 回写）';

CREATE TABLE IF NOT EXISTS `outbound_subscription` (
    `id`                   BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`              BIGINT NOT NULL,
    `event`                VARCHAR(32) NOT NULL COMMENT 'task.completed / task.failed / question.pending',
    `target_url`           VARCHAR(1024) NOT NULL,
    `secret_cipher`        TEXT NOT NULL COMMENT 'HMAC key，AES-GCM 加密存储',
    `enabled`              TINYINT(1) NOT NULL DEFAULT 1,
    `created_at`           DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`           DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY `idx_outbound_sub_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='出站事件订阅';

CREATE TABLE IF NOT EXISTS `outbound_delivery` (
    `id`               BIGINT PRIMARY KEY AUTO_INCREMENT,
    `subscription_id`  BIGINT NOT NULL,
    `event`            VARCHAR(32) NOT NULL,
    `payload`          JSON NOT NULL,
    `status`           VARCHAR(16) NOT NULL COMMENT 'PENDING/SENDING/SUCCEEDED/FAILED',
    `attempt_count`    INT NOT NULL DEFAULT 0,
    `next_retry_at`    DATETIME NULL,
    `last_http_status` INT NULL,
    `last_error`       VARCHAR(512) NULL,
    `created_at`       DATETIME DEFAULT CURRENT_TIMESTAMP,
    `sent_at`          DATETIME NULL,
    KEY `idx_outbound_delivery_retry` (`status`, `next_retry_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='出站投递记录（重试调度扫描）';
