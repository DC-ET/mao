-- 公司 SSO 使用单条 JSON 完整快照；不从环境变量导入。
INSERT INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`, `is_secret`) VALUES
('auth.companySso.config', '{"enabled":false,"allowedDomains":[],"allowedOrigins":[],"accessTtlSeconds":1800,"timeoutMs":3000}', '集成配置', '公司 SSO 完整 JSON 配置（HTTPS 强制启用，保存后即时生效）', 1, 0);
