-- 移除团队共享目录功能（0.0.326）：shared_agent_entry 表随功能代码一并移除。
-- V132 建表、V134 加 source_url 列；registry/URL 导入/检查更新所用 agent_import_origin 表不受影响。
DROP TABLE IF EXISTS `shared_agent_entry`;
