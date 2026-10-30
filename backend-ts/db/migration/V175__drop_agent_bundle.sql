-- 移除 Agent Bundle 导入/导出/检查更新：来源表与 registry 开关随功能代码一并移除。
-- V134 建 agent_import_origin 并写入 bundle.registry.* 设置。
DROP TABLE IF EXISTS `agent_import_origin`;

DELETE FROM `system_setting`
WHERE `setting_key` IN ('bundle.registry.enabled', 'bundle.registry.accessToken');
