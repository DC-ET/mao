ALTER TABLE `agent`
    ADD COLUMN `deleted` TINYINT NOT NULL DEFAULT 0 COMMENT 'Logical deletion flag: 0=normal, 1=deleted' AFTER `creator_id`;

ALTER TABLE `user_command`
    ADD COLUMN `deleted` TINYINT NOT NULL DEFAULT 0 COMMENT 'Logical deletion flag: 0=normal, 1=deleted' AFTER `content`;

ALTER TABLE `file`
    ADD COLUMN `deleted` TINYINT NOT NULL DEFAULT 0 COMMENT 'Logical deletion flag: 0=normal, 1=deleted' AFTER `session_id`;

ALTER TABLE `session_todo`
    ADD COLUMN `deleted` TINYINT NOT NULL DEFAULT 0 COMMENT 'Logical deletion flag: 0=normal, 1=deleted' AFTER `blocked_by`;

ALTER TABLE `llm_model`
    ADD COLUMN `deleted` TINYINT NOT NULL DEFAULT 0 COMMENT 'Logical deletion flag: 0=normal, 1=deleted' AFTER `is_default`;

ALTER TABLE `role`
    ADD COLUMN `deleted` TINYINT NOT NULL DEFAULT 0 COMMENT 'Logical deletion flag: 0=normal, 1=deleted' AFTER `description`;

ALTER TABLE `user`
    ADD COLUMN `deleted` TINYINT NOT NULL DEFAULT 0 COMMENT 'Logical deletion flag: 0=normal, 1=deleted' AFTER `last_login_at`;
