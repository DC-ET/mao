-- V035: Store execution environment snapshot for prompt context.

ALTER TABLE `session`
    ADD COLUMN `is_git` TINYINT(1) DEFAULT NULL COMMENT 'Whether session workspace is inside a git repository',
    ADD COLUMN `platform` VARCHAR(20) DEFAULT NULL COMMENT 'Execution platform: darwin|linux|win32',
    ADD COLUMN `shell_path` VARCHAR(255) DEFAULT NULL COMMENT 'Shell path/name for execution environment',
    ADD COLUMN `os_version` VARCHAR(255) DEFAULT NULL COMMENT 'OS version, similar to uname -sr';
