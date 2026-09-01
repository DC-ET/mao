-- V094: 全网搜索（web_search 工具）支持 Tavily / TinyFish 双实现后台切换。
-- 新增 provider 开关与 TinyFish API Key（secret，AES 加密入库）。
-- value 初始为 NULL 表示"从未设置"（启动时由 SettingsBootstrap 用环境变量填充）。

INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('tools.webSearchProvider', NULL, '集成配置', '全网搜索实现：tavily（默认）或 tinyfish', 1),
('tools.tinyfishApiKey', NULL, '集成配置', 'TinyFish 搜索 API Key（web_search 工具，搜索实现=tinyfish 时使用）', 1);

UPDATE `system_setting` SET `is_secret` = 1 WHERE `setting_key` = 'tools.tinyfishApiKey';
