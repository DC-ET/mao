-- 系统默认 Git 凭据（技术方案 2026-11-12「系统默认 Git 凭据（管理员默认 Token 兜底）」）：
-- 管理员按域名托管系统默认 Token；凭据解析时逐域兜底——用户配了该域用用户的，没配的域用系统默认。
-- 与 user_git_credential（V047）同款加密口径（AES-CBC + APP_GIT_CREDENTIAL_SECRET），不引入新密钥。
-- 不挂用户、不建外键；表空 = 功能未启用，行为与现状完全一致。

CREATE TABLE IF NOT EXISTS `system_git_credential` (
    `id`           BIGINT PRIMARY KEY AUTO_INCREMENT,
    `domain`       VARCHAR(255) NOT NULL COMMENT 'Git 服务器域名，如 git.acg.team',
    `access_token` VARCHAR(2048) NOT NULL COMMENT 'Access Token（AES 加密存储）',
    `description`  VARCHAR(512) NULL COMMENT '备注，如「只读 Token，写权限请联系 XX」',
    `created_at`   DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_system_git_domain` (`domain`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='系统默认 Git 凭据（管理员配置，用户未配置该域时兜底）';
