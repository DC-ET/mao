-- 系统设置增加会话标题生成模型配置

INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('session.titleModelId', '', '会话', '生成会话标题使用的模型 ID，留空则使用默认模型', 1);
