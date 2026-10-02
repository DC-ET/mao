-- 跨会话长期记忆（Memory 层）P2：记忆自动抽取使用的模型配置，留空回落系统默认模型。

INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('memory.extractionModelId', '', '记忆', '记忆自动抽取使用的模型 ID，留空则使用默认模型', 1);
