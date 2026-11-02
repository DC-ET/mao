-- V179: 账号密码登录开关。默认开启，与升级前行为一致。
-- 关闭后只影响桌面 / Web / 安卓与 POST /auth/login（含 LDAP）。
-- 管理后台 POST /auth/admin/login 始终可用，给本地 admin 留入口。
-- 保存为 false 时须已启用飞书 OAuth（真实 App ID）或 ECP 飞书登录，避免桌面端没有任何入口。
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`, `is_secret`) VALUES
('auth.password.enabled', 'true', '集成配置', '账号密码登录开关（关闭后桌面端隐藏用户名密码并拒绝 /auth/login，含 LDAP；管理后台密码登录保留；须已启用飞书 OAuth 或 ECP）', 1, 0);
