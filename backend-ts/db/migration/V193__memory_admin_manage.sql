-- 管理后台记忆管理权限码（读写分离，模式同 V121）：
-- memory:read 已由 V129 授予 role_id=1；write 码同口径只授系统管理员，不向其他角色复制
-- （复制会导致原本只读审计的角色获得改他人记忆的能力）。
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '管理用户记忆', 'memory:write', '编辑、忽略、恢复、删除、代建任意用户的长期记忆'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'memory:write');

INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT 1, id FROM `permission`
WHERE `code` = 'memory:write';
