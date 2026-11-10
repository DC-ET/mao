-- V191: 钉钉 OAuth 登录配置后台化（对齐 V093 飞书 OAuth 的做法）。
-- 原为环境变量 DINGTALK_OAUTH_CLIENT_ID / DINGTALK_OAUTH_SECRET / DINGTALK_OAUTH_REDIRECT_URI，
-- 迁入 system_setting 后由 SystemSettingService.getDingtalkOauthConfig() 实时读取，
-- 管理员在管理后台「系统设置 → 登录认证 → 钉钉 OAuth 登录」即可维护，无需改 .env 重启。
-- value 初始为 NULL 表示「从未设置」：启动时由 SettingsBootstrap 用环境变量一次性导入
-- （runSettingsBootstrap 的幂等语义：管理员在后台保存过的行——包括显式清空为 ''——不再被覆盖）。
-- 登录应用必须与机器人同一企业，否则「根据 unionid 查询用户」拿不到 userid，绑定会失败。

INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('dingtalk.oauth.clientId', NULL, '集成配置', '钉钉 OAuth Client ID（绑定用登录应用，须与机器人同一企业）', 1),
('dingtalk.oauth.clientSecret', NULL, '集成配置', '钉钉 OAuth Client Secret', 1),
('dingtalk.oauth.redirectUri', NULL, '集成配置', '钉钉 OAuth 回调地址', 1);

UPDATE `system_setting` SET `is_secret` = 1 WHERE `setting_key` = 'dingtalk.oauth.clientSecret';
