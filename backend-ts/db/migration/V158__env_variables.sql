-- V158: 用户 / 工作区 / 系统三级环境变量（技术方案 docs/plan/2026-10-18-env-variables-technical-design.md）。
-- 值一律 AES-CBC 加密（复用 APP_GIT_CREDENTIAL_SECRET），VARCHAR(4096) 存的是密文：
-- 明文上限 2048 字符 → PKCS7 补齐后 2064 字节 → base64 2752 字符 + IV/分隔符，余量充足。

CREATE TABLE IF NOT EXISTS `user_env_variable` (
    `id`         BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
    `user_id`    BIGINT       NOT NULL COMMENT '所属用户',
    `env_key`    VARCHAR(128) NOT NULL COMMENT '变量名，POSIX 合法标识符',
    `env_value`  VARCHAR(4096) NOT NULL COMMENT '变量值（AES-CBC 密文）',
    `note`       VARCHAR(256) NULL COMMENT '备注，如 "私有 Gitea Token"',
    `created_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_user_key` (`user_id`, `env_key`),
    INDEX `idx_user_id` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户全局环境变量';

CREATE TABLE IF NOT EXISTS `workspace_env_variable` (
    `id`             BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
    `workspace_path` VARCHAR(512) NOT NULL COMMENT '工作区绝对路径（path.resolve 归一化）',
    `user_id`        BIGINT       NOT NULL COMMENT '配置者；仅配置者本人会话生效',
    `env_key`        VARCHAR(128) NOT NULL COMMENT '变量名',
    `env_value`      VARCHAR(4096) NOT NULL COMMENT '变量值（AES-CBC 密文）',
    `note`           VARCHAR(256) NULL COMMENT '备注',
    `created_at`     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at`     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_workspace_user_key` (`workspace_path`, `user_id`, `env_key`),
    INDEX `idx_workspace_user` (`workspace_path`, `user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工作区环境变量（按绝对路径 + 用户绑定）';

CREATE TABLE IF NOT EXISTS `system_env_variable` (
    `id`         BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
    `env_key`    VARCHAR(128) NOT NULL COMMENT '变量名',
    `env_value`  VARCHAR(4096) NOT NULL COMMENT '变量值（AES-CBC 密文）',
    `note`       VARCHAR(256) NULL COMMENT '备注，如 "内网 npm 镜像"',
    `created_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_key` (`env_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统全局环境变量（管理员维护，全站生效）';

-- 注入总开关：紧急一键停用三层变量（关闭后仅保留平台内置凭据）。默认开启。
INSERT IGNORE INTO `system_setting`
  (`setting_key`, `value`, `category`, `description`, `editable`, `is_secret`)
VALUES
  ('shell.envVars.enabled', 'true', 'Shell 环境', '环境变量注入总开关（关闭后三层变量全部不注入，仅保留平台内置凭据）', 1, 0);
