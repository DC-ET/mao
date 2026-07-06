CREATE TABLE IF NOT EXISTS `user_git_credential` (
    `id`             BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`        BIGINT NOT NULL COMMENT '用户 ID',
    `domain`         VARCHAR(255) NOT NULL COMMENT 'Git 服务器域名，如 github.com',
    `access_token`   VARCHAR(2048) NOT NULL COMMENT 'Access Token（AES 加密存储）',
    `description`    VARCHAR(512) COMMENT '凭证备注，如 "个人 GitHub Token"',
    `created_at`     DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`     DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_user_domain` (`user_id`, `domain`),
    INDEX `idx_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
