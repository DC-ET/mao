-- 软删角色后释放名称和编码，允许用同一名称/编码再建。
-- deleted_token：存活为 0，软删后写成角色 id。(name, token) / (code, token) 因此只约束存活行。
ALTER TABLE `role`
    ADD COLUMN `deleted_token` BIGINT NOT NULL DEFAULT 0 COMMENT '0=存活；软删后写成角色 id，用于释放 name/code 唯一约束' AFTER `deleted`,
    DROP INDEX `name`,
    DROP INDEX `code`,
    ADD UNIQUE KEY `uk_role_name` (`name`, `deleted_token`),
    ADD UNIQUE KEY `uk_role_code` (`code`, `deleted_token`);
