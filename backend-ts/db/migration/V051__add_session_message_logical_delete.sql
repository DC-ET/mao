ALTER TABLE `session`
    ADD COLUMN `deleted` TINYINT NOT NULL DEFAULT 0 COMMENT 'Logical deletion flag: 0=normal, 1=deleted' AFTER `session_type`;

ALTER TABLE `message`
    ADD COLUMN `deleted` TINYINT NOT NULL DEFAULT 0 COMMENT 'Logical deletion flag: 0=normal, 1=deleted' AFTER `source_session_id`;
