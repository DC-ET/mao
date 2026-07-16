-- 系统设置增加微信通道模型配置

INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('weixin.modelId', '', '微信', '微信通道使用的模型 ID，留空则使用默认模型', 1);
