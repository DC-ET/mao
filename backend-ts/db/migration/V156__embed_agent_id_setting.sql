-- V156: 管理后台浮窗助手 Agent 配置（embed.agentId）。
-- admin 接入 Web Embed SDK（docs/plan/2026-10-16-admin-embed-chat-technical-design.md）：
-- 浮窗对话使用的 Agent；留空（NULL/空串）时由 GET /v1/embed/admin-config 回落系统默认 Agent。
-- value 初始 NULL 表示"从未设置"（与 auth.ldap.* 一致，消费方 hasText 判空不区分 NULL/空串）。
-- 分类「集成配置」：该分类既有 key 均被前端 SPECIAL_KEYS 排除、走 IntegrationConfigPanel 渲染，
-- 本行作为独立分类 section 出现在系统设置页「登录认证」分组（SystemSettingsView TOC_GROUPS）。

INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('embed.agentId', NULL, '集成配置', '管理后台浮窗助手使用的 Agent ID（留空回落系统默认 Agent）', 1);
