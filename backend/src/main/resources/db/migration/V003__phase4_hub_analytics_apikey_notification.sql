-- Agent Hub 增强
CREATE TABLE IF NOT EXISTS `agent_rating` (
    `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`    BIGINT NOT NULL,
    `agent_id`   BIGINT NOT NULL,
    `score`      TINYINT NOT NULL COMMENT '评分 1-5',
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_user_agent` (`user_id`, `agent_id`),
    INDEX `idx_agent` (`agent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `agent_comment` (
    `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`    BIGINT NOT NULL,
    `agent_id`   BIGINT NOT NULL,
    `content`    TEXT NOT NULL,
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_agent` (`agent_id`),
    INDEX `idx_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Agent 分类字段 (idempotent)
DROP PROCEDURE IF EXISTS add_column_if_not_exists;
DELIMITER //
CREATE PROCEDURE add_column_if_not_exists()
BEGIN
    IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent' AND COLUMN_NAME = 'category') THEN
        ALTER TABLE `agent` ADD COLUMN `category` VARCHAR(64) DEFAULT 'general' COMMENT 'Agent 分类' AFTER `visibility`;
    END IF;
END //
DELIMITER ;
CALL add_column_if_not_exists();
DROP PROCEDURE add_column_if_not_exists;

-- API Key 管理
CREATE TABLE IF NOT EXISTS `api_key` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`     BIGINT NOT NULL,
    `name`        VARCHAR(128) NOT NULL COMMENT 'Key 名称',
    `api_key`     VARCHAR(128) NOT NULL UNIQUE COMMENT 'API Key',
    `permissions` JSON COMMENT '权限列表',
    `rate_limit`  INT DEFAULT 100 COMMENT '每分钟请求限制',
    `status`      TINYINT DEFAULT 1 COMMENT '1-启用 0-禁用',
    `last_used_at` DATETIME,
    `expires_at`  DATETIME COMMENT '过期时间',
    `created_at`  DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_user` (`user_id`),
    INDEX `idx_key` (`api_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 通知系统
CREATE TABLE IF NOT EXISTS `notification` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`     BIGINT NOT NULL,
    `type`        VARCHAR(32) NOT NULL COMMENT '通知类型: SYSTEM/TASK/AGENT',
    `title`       VARCHAR(256) NOT NULL,
    `content`     TEXT,
    `is_read`     TINYINT DEFAULT 0,
    `related_type` VARCHAR(32) COMMENT '关联资源类型',
    `related_id`  BIGINT COMMENT '关联资源 ID',
    `created_at`  DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_user` (`user_id`),
    INDEX `idx_read` (`user_id`, `is_read`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
