-- V161: 邮件通知渠道（第三通知渠道：飞书/钉钉/邮件）。
-- 消费方 EmailSmtpSettings：缺行/未启用 = 邮件渠道不可用（偏好保存 EMAIL 时拒绝并提示联系管理员）。
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('notify.email.enabled',   '0',    '通知与消息', '邮件通知渠道开关：0=关（默认），1=开。开启后用户可在消息通知里选择邮件渠道', 1),
('notify.email.smtpHost',  NULL,   '通知与消息', 'SMTP 服务器地址', 1),
('notify.email.smtpPort',  '465',  '通知与消息', 'SMTP 端口（TLS 465 / STARTTLS 587）', 1),
('notify.email.smtpSecure','1',    '通知与消息', '是否使用 TLS 隐式加密：1=是（465），0=STARTTLS（587）', 1),
('notify.email.smtpUser',  NULL,   '通知与消息', 'SMTP 登录用户名', 1),
('notify.email.smtpPassword', NULL,'通知与消息', 'SMTP 登录密码（加密存储）', 1),
('notify.email.fromAddr',  NULL,   '通知与消息', '发件人地址（留空则使用 SMTP 用户名）', 1);

-- 密码行按 V093 同款句式标记 secret（加密存储 + 掩码回显）。
UPDATE `system_setting` SET `is_secret` = 1 WHERE `setting_key` = 'notify.email.smtpPassword';
