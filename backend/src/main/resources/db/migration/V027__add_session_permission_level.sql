-- V027: Add permission_level to session table for LOCAL mode tool permission control.

ALTER TABLE `session`
    ADD COLUMN `permission_level` VARCHAR(20) NOT NULL DEFAULT 'READ_ONLY'
    COMMENT 'LOCAL mode tool permission: READ_ONLY|READ_WRITE|SMART|FULL';
