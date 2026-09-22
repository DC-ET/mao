-- 定时任务管理权限：跨用户编辑、启停、删除定时任务
-- 读（列表/详情）继续由 session:read 控制；写操作单独收口到本权限点，并授予系统管理员角色（role_id = 1）
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '管理定时任务', 'scheduled-task:write', '跨用户编辑、启停、删除定时任务'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'scheduled-task:write');

INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT 1, id FROM `permission` WHERE `code` = 'scheduled-task:write'
  AND NOT EXISTS (SELECT 1 FROM `role_permission` WHERE `role_id` = 1 AND `permission_id` = `permission`.`id`);
