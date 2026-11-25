-- 会话标题模型留空时跟随当前会话所用模型，更新设置说明。

UPDATE `system_setting`
SET `description` = '生成会话标题使用的模型 ID，留空则使用当前会话所用模型'
WHERE `setting_key` = 'session.titleModelId';
