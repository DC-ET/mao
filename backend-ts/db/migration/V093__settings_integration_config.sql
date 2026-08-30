-- V093: 集成配置后台化 —— LDAP / 飞书OAuth登录 / 上传 / Tavily / OSS 从 yml+环境变量迁入 system_setting。
-- value 初始为 NULL 表示"从未设置"（启动时由 SettingsBootstrap 用环境变量填充）；
-- 后台保存过（包括显式清空为 ''）的行不再被导入覆盖。

ALTER TABLE `system_setting` MODIFY COLUMN `value` TEXT NULL;
ALTER TABLE `system_setting` ADD COLUMN `is_secret` TINYINT NOT NULL DEFAULT 0;

-- 已有行转为真实可编辑配置。
-- value 重置为 NULL：V048 当年插入的是占位值（'false'/'50'），并非管理员设置的真实配置；
-- 重置后由启动时 SettingsBootstrap 用环境变量（LDAP_ENABLED/FEISHU_ENABLED/FILE_MAX_SIZE_MB）填充，
-- 此后以 DB 为准。
UPDATE `system_setting` SET `category` = '集成配置', `editable` = 1, `description` = 'LDAP 登录开关', `value` = NULL WHERE `setting_key` = 'auth.ldap.enabled';
UPDATE `system_setting` SET `category` = '集成配置', `editable` = 1, `description` = '飞书登录开关', `value` = NULL WHERE `setting_key` = 'auth.feishu.enabled';
UPDATE `system_setting` SET `description` = '单文件上传大小上限（MB）', `value` = NULL WHERE `setting_key` = 'file.maxSizeMb';

INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('auth.ldap.url', NULL, '集成配置', 'LDAP 服务地址（ldap:// 或 ldaps://）', 1),
('auth.ldap.baseDn', NULL, '集成配置', 'LDAP Base DN', 1),
('auth.ldap.userDn', NULL, '集成配置', 'LDAP 绑定账号 DN', 1),
('auth.ldap.password', NULL, '集成配置', 'LDAP 绑定密码', 1),
('auth.ldap.userSearchBase', NULL, '集成配置', 'LDAP 用户搜索 Base（默认 ou=users）', 1),
('auth.feishu.appId', NULL, '集成配置', '飞书应用 App ID', 1),
('auth.feishu.appSecret', NULL, '集成配置', '飞书应用 App Secret', 1),
('auth.feishu.redirectUri', NULL, '集成配置', '飞书 OAuth 回调地址', 1),
('upload.storageMode', NULL, '集成配置', '上传存储模式：local（本地）或 oss（对象存储）', 1),
('upload.baseUrl', NULL, '集成配置', '上传文件访问基础地址（留空使用相对路径）', 1),
('tools.tavilyApiKey', NULL, '集成配置', 'Tavily 搜索 API Key（web_search 工具）', 1),
('oss.region', NULL, '集成配置', 'OSS Region', 1),
('oss.accessKeyId', NULL, '集成配置', 'OSS AccessKey ID', 1),
('oss.accessKeySecret', NULL, '集成配置', 'OSS AccessKey Secret', 1),
('oss.bucket', NULL, '集成配置', 'OSS Bucket', 1),
('oss.sts.regionId', NULL, '集成配置', 'OSS STS Region ID', 1),
('oss.sts.endpoint', NULL, '集成配置', 'OSS STS Endpoint', 1),
('oss.sts.accessKeyId', NULL, '集成配置', 'OSS STS AccessKey ID', 1),
('oss.sts.accessKeySecret', NULL, '集成配置', 'OSS STS AccessKey Secret', 1),
('oss.sts.roleArn', NULL, '集成配置', 'OSS STS Role ARN', 1),
('oss.sts.roleSessionName', NULL, '集成配置', 'OSS STS 会话名（默认 mao-sts）', 1),
('oss.sts.expire', NULL, '集成配置', 'OSS STS 凭证有效期秒数（默认 3600）', 1),
('oss.sts.maxSizeMb', NULL, '集成配置', 'OSS 直传单文件大小上限 MB（预留，暂未生效）', 1);

UPDATE `system_setting` SET `is_secret` = 1
WHERE `setting_key` IN ('auth.ldap.password', 'auth.feishu.appSecret', 'tools.tavilyApiKey', 'oss.accessKeySecret', 'oss.sts.accessKeySecret');

-- 系统设置权限码（不指定自增 id，避免硬编码 id 与存量数据冲突时被 INSERT IGNORE 静默跳过）
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '查看系统设置', 'settings:read', '查看系统设置'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'settings:read');
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '管理系统设置', 'settings:write', '修改系统设置'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'settings:write');

INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT 1, id FROM `permission` WHERE `code` IN ('settings:read', 'settings:write')
  AND NOT EXISTS (SELECT 1 FROM `role_permission` WHERE `role_id` = 1 AND `permission_id` = `permission`.`id`);
