-- V170: 站点根 URL（网页深链 origin 来源）。
-- 消费方 SystemSettingService.getSiteBaseUrl()：本行优先，留空回落 upload.baseUrl，
-- 两者都空时深链按钮不渲染。用于飞书/钉钉卡片「会话详情」等 /tasks/{id} 链接，
-- 避免复用未启用 ECP 功能的占位回调域名（mao.example.com）。
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('site.baseUrl', NULL, '集成配置', '站点根地址（如 https://mao.example.com）：IM 卡片「会话详情」等网页深链的域名来源，留空回落上传基础地址', 1);
