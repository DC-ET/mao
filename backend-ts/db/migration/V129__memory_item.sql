-- 跨会话长期记忆（Memory 层）P1：
-- memory_item 记忆条目（USER/PROJECT 两级作用域，个人归属）+ user_memory_preference 自动收集开关。
-- 去重：dedup_hash = SHA1("{scope}|{project_key}|{规范化 content}")，同用户唯一。

CREATE TABLE IF NOT EXISTS `memory_item` (
    `id`                BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`           BIGINT NOT NULL,
    `scope`             VARCHAR(16) NOT NULL COMMENT 'USER/PROJECT',
    `project_key`       VARCHAR(128) NOT NULL DEFAULT '' COMMENT 'PROJECT 级绑定 session.projectKey；USER 级为空串',
    `content`           TEXT NOT NULL,
    `source`            VARCHAR(16) NOT NULL DEFAULT 'MANUAL' COMMENT 'AUTO=Agent 抽取 / MANUAL=用户手写',
    `status`            VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE/DISMISSED',
    `dedup_hash`        CHAR(40) NOT NULL COMMENT 'SHA-1(scope|project_key|规范化 content)',
    `origin_session_id` BIGINT NULL COMMENT 'AUTO 抽取来源会话',
    `created_at`        DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`        DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_memory_dedup` (`user_id`, `dedup_hash`),
    INDEX `idx_memory_user` (`user_id`, `scope`, `status`),
    INDEX `idx_memory_project` (`user_id`, `project_key`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `user_memory_preference` (
    `user_id`              BIGINT PRIMARY KEY,
    `auto_capture_enabled` TINYINT(1) NOT NULL DEFAULT 0 COMMENT '自动收集开关，默认关闭（关闭时现有功能零影响）',
    `created_at`           DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`           DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 管理后台只读审计权限码（模式同 V121，无对应 write 码：admin 仅只读）
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '查看用户记忆', 'memory:read', '只读查看指定用户的长期记忆内容（审计用途）'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'memory:read');

INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT 1, id FROM `permission`
WHERE `code` = 'memory:read';
