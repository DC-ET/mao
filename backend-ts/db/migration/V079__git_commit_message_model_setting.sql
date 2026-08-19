-- 系统设置增加 Git 提交信息生成模型配置

INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('git.commitMessageModelId', '', '代码', '生成 Git 提交信息使用的模型 ID，留空则使用默认模型', 1);