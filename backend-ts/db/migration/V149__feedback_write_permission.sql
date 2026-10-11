-- 点踩反馈写权限 + 起草模型设置项种子。
--
-- 权限：草稿生成、确认转经验、忽略三个动作需要 feedback:write；读（汇总 / 明细）继续由
-- V123 注册的 feedback:read 控制。权限码按 V121 目录模式注册，默认只授系统管理员角色
-- （role_id = 1）。
--
-- 设置项：feedback.draftModelId 指定「负反馈转经验」起草用的模型，留空回落默认模型。
-- 归入「Agent 与模型」渲染分组（admin 系统设置页 MODEL_SELECT_KEYS），与
-- git.commitMessageModelId 同款（V079）。

INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '处理点踩反馈', 'feedback:write', '将点踩反馈转为 Agent 经验或忽略'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'feedback:write');

INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT 1, id FROM `permission` WHERE `code` = 'feedback:write';

INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('feedback.draftModelId', '', 'Agent 与模型', '负反馈转经验的起草模型 ID，留空则使用默认模型', 1);
