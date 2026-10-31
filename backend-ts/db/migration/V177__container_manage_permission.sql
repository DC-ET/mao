-- 容器重建管理权限：重建用户容器（单用户 / 列表）。
-- 读（容器列表）与写（重建）统一由本权限点收口，授予系统管理员角色（role_id = 1）。
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '管理容器', 'container:manage', '查看用户容器列表、重建用户容器'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'container:manage');

INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT 1, id FROM `permission` WHERE `code` = 'container:manage'
  AND NOT EXISTS (SELECT 1 FROM `role_permission` WHERE `role_id` = 1 AND `permission_id` = `permission`.`id`);
