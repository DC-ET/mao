-- 文件管理表
CREATE TABLE `file` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `original_name` VARCHAR(256) NOT NULL COMMENT '原始文件名',
    `stored_name`   VARCHAR(256) NOT NULL COMMENT '存储文件名',
    `file_path`     VARCHAR(512) NOT NULL COMMENT '存储路径',
    `file_size`     BIGINT NOT NULL COMMENT '文件大小(字节)',
    `mime_type`     VARCHAR(128) COMMENT 'MIME 类型',
    `uploader_id`   BIGINT NOT NULL COMMENT '上传者用户 ID',
    `session_id`    BIGINT COMMENT '关联会话 ID',
    `created_at`    DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_uploader` (`uploader_id`),
    INDEX `idx_session` (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 系统配置表
CREATE TABLE `system_config` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `config_key`  VARCHAR(128) NOT NULL UNIQUE COMMENT '配置键',
    `config_value` TEXT COMMENT '配置值',
    `description` VARCHAR(256) COMMENT '配置说明',
    `updated_at`  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 初始系统配置
INSERT INTO `system_config` (`config_key`, `config_value`, `description`) VALUES
('site.name', 'Agent Workbench', '站点名称'),
('site.logo', '', '站点 Logo URL'),
('feishu.app_id', '', '飞书应用 App ID'),
('feishu.app_secret', '', '飞书应用 App Secret'),
('ldap.url', '', 'LDAP 服务器地址'),
('ldap.base_dn', '', 'LDAP Base DN'),
('ldap.user_dn', '', 'LDAP 用户 DN'),
('ldap.password', '', 'LDAP 绑定密码'),
('file.max_size_mb', '50', '单文件最大大小(MB)'),
('file.allowed_types', 'jpg,jpeg,png,gif,pdf,doc,docx,xls,xlsx,ppt,pptx,txt,md,json,csv,zip', '允许上传的文件类型');
