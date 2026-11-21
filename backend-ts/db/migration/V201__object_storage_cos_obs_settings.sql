-- V201: 多云对象存储（技术方案 docs/plan/2026-11/2026-11-21-object-storage-multi-cloud-technical-design.md）。
-- 新增腾讯云 COS / 华为云 OBS 配置组，与既有 oss.* 同为"预签名 PUT 直传"模式。
-- value 初始为 NULL 表示"从未设置"（启动时由 SettingsBootstrap 用环境变量填充）；
-- 后台保存过（包括显式清空为 ''）的行不再被导入覆盖。

INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('cos.region', NULL, '集成配置', '腾讯云 COS 地域（如 ap-guangzhou）', 1),
('cos.secretId', NULL, '集成配置', '腾讯云 COS SecretId', 1),
('cos.secretKey', NULL, '集成配置', '腾讯云 COS SecretKey', 1),
('cos.bucket', NULL, '集成配置', '腾讯云 COS Bucket（含 APPID 后缀，如 name-1250000000）', 1),
('obs.endpoint', NULL, '集成配置', '华为云 OBS 终端节点（如 obs.cn-north-4.myhuaweicloud.com）', 1),
('obs.accessKeyId', NULL, '集成配置', '华为云 OBS AccessKey ID', 1),
('obs.accessKeySecret', NULL, '集成配置', '华为云 OBS AccessKey Secret', 1),
('obs.bucket', NULL, '集成配置', '华为云 OBS Bucket', 1);

UPDATE `system_setting` SET `is_secret` = 1 WHERE `setting_key` IN ('cos.secretKey', 'obs.accessKeySecret');

-- oss.sts.* 八行随 STS 直传链路废弃：后端不再读取，行保留供历史回溯；
-- 置为不可编辑并改写描述，避免管理员误以为仍需配置。
UPDATE `system_setting`
SET `description` = CONCAT('已废弃（STS 直传改为预签名直传，无需配置）：', `description`), `editable` = 0
WHERE `setting_key` LIKE 'oss.sts.%';

UPDATE `system_setting`
SET `description` = '上传存储模式：local（本地）/ oss（阿里云 OSS）/ cos（腾讯云 COS）/ obs（华为云 OBS）'
WHERE `setting_key` = 'upload.storageMode';
