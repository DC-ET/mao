-- 管理后台权限点补全。新码默认只授给系统管理员（role_id=1）。
-- 原先靠借用权限码才能看见的页面，复制到除 USER（role_id=2）以外的已有角色，避免菜单消失。
-- USER 仍只有 agent:read、model:read。飞书/钉钉/指令/MCP/用量分析/调用流水/会话写不从旧码复制。

INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '查看 Skills', 'skill:read', '打开 Skills 管理，查看系统技能与全部用户技能'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'skill:read');
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '管理 Skills', 'skill:write', '上传、删除系统技能；代用户上传、删除个人技能'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'skill:write');

INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '查看飞书机器人', 'feishu-bot:read', '查看飞书机器人列表、详情和连接状态'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'feishu-bot:read');
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '管理飞书机器人', 'feishu-bot:write', '创建、编辑、删除、启停、重连飞书机器人'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'feishu-bot:write');

INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '查看钉钉机器人', 'dingtalk-bot:read', '查看钉钉机器人列表、详情和连接状态'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'dingtalk-bot:read');
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '管理钉钉机器人', 'dingtalk-bot:write', '创建、编辑、删除、启停、重连钉钉机器人'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'dingtalk-bot:write');

INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '查看指令', 'command:read', '查看系统指令与用户指令'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'command:read');
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '管理指令', 'command:write', '管理系统指令；提升或删除用户指令'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'command:write');

INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '查看 MCP', 'mcp:read', '查看全局 MCP 与指定用户的私有服务器（环境变量不回明文）'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'mcp:read');
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '管理 MCP', 'mcp:write', '管理全局 MCP；停用或删除他人私有服务器'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'mcp:write');

INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '管理会话', 'session:write', '归档、删除会话'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'session:write');
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '查看定时任务', 'scheduled-task:read', '跨用户查看定时任务列表、详情和 Cron 预览'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'scheduled-task:read');
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '查看调用流水', 'llm-call:read', '查看全站模型调用流水'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'llm-call:read');
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '查看用量分析', 'analytics:read', '查看用量分析'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'analytics:read');

INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '查看角色', 'role:read', '查看角色与权限目录'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'role:read');
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '管理角色', 'role:write', '新建、编辑角色，并给角色分配权限点'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'role:write');
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '查看审计日志', 'audit:read', '查看审计日志'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'audit:read');

INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT 1, id FROM `permission`
WHERE `code` IN (
  'skill:read', 'skill:write',
  'feishu-bot:read', 'feishu-bot:write',
  'dingtalk-bot:read', 'dingtalk-bot:write',
  'command:read', 'command:write',
  'mcp:read', 'mcp:write',
  'session:write', 'scheduled-task:read',
  'llm-call:read', 'analytics:read',
  'role:read', 'role:write', 'audit:read'
);

-- 借码页面：除 USER 外，按原权限补上新的读/写码。
INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT rp.role_id, np.id
FROM `role_permission` rp
JOIN `permission` op ON op.id = rp.permission_id AND op.code = 'agent:read'
JOIN `permission` np ON np.code = 'skill:read'
WHERE rp.role_id <> 2;

INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT rp.role_id, np.id
FROM `role_permission` rp
JOIN `permission` op ON op.id = rp.permission_id AND op.code = 'agent:write'
JOIN `permission` np ON np.code = 'skill:write'
WHERE rp.role_id <> 2;

INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT rp.role_id, np.id
FROM `role_permission` rp
JOIN `permission` op ON op.id = rp.permission_id AND op.code = 'session:read'
JOIN `permission` np ON np.code = 'scheduled-task:read'
WHERE rp.role_id <> 2;

INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT rp.role_id, np.id
FROM `role_permission` rp
JOIN `permission` op ON op.id = rp.permission_id AND op.code = 'user:read'
JOIN `permission` np ON np.code = 'audit:read'
WHERE rp.role_id <> 2;

INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT rp.role_id, np.id
FROM `role_permission` rp
JOIN `permission` op ON op.id = rp.permission_id AND op.code = 'user:write'
JOIN `permission` np ON np.code IN ('role:read', 'role:write')
WHERE rp.role_id <> 2;
