CREATE TABLE IF NOT EXISTS `audit_log` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`       BIGINT NULL,
    `username`      VARCHAR(128) NULL,
    `action`        VARCHAR(32) NOT NULL COMMENT 'READ/CREATE/UPDATE/DELETE/EXECUTE',
    `object_type`   VARCHAR(64) NOT NULL COMMENT '被操作对象类型',
    `object_id`     VARCHAR(128) NULL COMMENT '被操作对象 ID',
    `method`        VARCHAR(16) NOT NULL,
    `path`          VARCHAR(512) NOT NULL,
    `query_string`  VARCHAR(1024) NULL,
    `ip`            VARCHAR(64) NULL,
    `status`        INT NULL,
    `success`       TINYINT NOT NULL DEFAULT 1,
    `error_message` VARCHAR(1024) NULL,
    `created_at`    DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_audit_created` (`created_at`),
    INDEX `idx_audit_user` (`user_id`),
    INDEX `idx_audit_object` (`object_type`, `object_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `system_setting` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `setting_key` VARCHAR(128) NOT NULL UNIQUE,
    `value`       VARCHAR(1024) NULL,
    `category`    VARCHAR(64) NOT NULL,
    `description` VARCHAR(256) NULL,
    `editable`    TINYINT NOT NULL DEFAULT 1,
    `created_at`  DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('file.maxSizeMb', '50', '文件', '单文件上传大小上限（MB）', 1),
('audit.retentionDays', '180', '审计', '审计日志建议保留天数', 1),
('ui.defaultPageSize', '20', '界面', '后台列表默认分页大小', 1),
('auth.feishu.enabled', 'false', '认证', '飞书登录开关状态展示', 0),
('auth.ldap.enabled', 'false', '认证', 'LDAP 登录开关状态展示', 0),
('workspace.root', '/opt/mao/data/workspace', '运行环境', 'Agent 工作区根目录展示', 0),
('skills.dir', '/opt/mao/data/skills', '运行环境', 'Skill 目录展示', 0);

CREATE TABLE IF NOT EXISTS `notification` (
    `id`           BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`      BIGINT NULL,
    `type`         VARCHAR(32) NOT NULL,
    `title`        VARCHAR(256) NOT NULL,
    `content`      TEXT NULL,
    `is_read`      TINYINT DEFAULT 0,
    `related_type` VARCHAR(32) NULL,
    `related_id`   BIGINT NULL,
    `created_at`   DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_notification_user` (`user_id`),
    INDEX `idx_notification_read` (`user_id`, `is_read`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
