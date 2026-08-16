-- V076: 部署目录迁移后，将 session.workspace 与 system_setting 中的旧路径前缀替换为新路径。
-- 注意：显式 SET updated_at = updated_at，避免 ON UPDATE CURRENT_TIMESTAMP 改写更新时间。

UPDATE `session`
SET
    `workspace` = REPLACE(`workspace`, '/root/soft/mao/data/workspace', '/opt/mao-data/workspace'),
    `updated_at` = `updated_at`
WHERE `workspace` LIKE '/root/soft/mao/data/workspace%';

UPDATE `system_setting`
SET
    `value` = '/opt/mao-data/workspace',
    `updated_at` = `updated_at`
WHERE `setting_key` = 'workspace.root'
  AND `value` <> '/opt/mao-data/workspace';

UPDATE `system_setting`
SET
    `value` = '/opt/mao-data/skills',
    `updated_at` = `updated_at`
WHERE `setting_key` = 'skills.dir'
  AND `value` <> '/opt/mao-data/skills';
