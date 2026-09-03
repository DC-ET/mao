-- V100: 云端终端（Cloud Remote Terminal）—— 并发与回收参数 + terminal:use 权限
-- value 初始为 NULL 表示"从未设置"（消费方用代码默认值）；此后一律以 DB 为准。
-- 生效时机：均为启动时构建（TerminalManager 构造时固化），修改后需重启后端。
-- 代码默认值：maxSessionsPerTask=5 / maxSessionsGlobal=50 / idleTimeoutMinutes=120 /
--   maxLifetimeHours=24 / outputBufferBytes=262144。

INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('terminal.maxSessionsPerTask', NULL, '运行参数', '每个任务并发云端终端上限（重启后端后生效，默认 5）', 1),
('terminal.maxSessionsGlobal', NULL, '运行参数', '全局并发云端终端上限（重启后端后生效，默认 50）', 1),
('terminal.idleTimeoutMinutes', NULL, '运行参数', '云端终端空闲回收分钟（无输入输出且无连接，重启后端后生效，默认 120）', 1),
('terminal.maxLifetimeHours', NULL, '运行参数', '云端终端最长存活小时（重启后端后生效，默认 24）', 1),
('terminal.outputBufferBytes', NULL, '运行参数', '单个云端终端输出环形缓冲上限字节（重启后端后生效，默认 262144）', 1);

-- 云端终端权限码：默认只授予 role_id=1（ADMIN）。
-- 注意：该权限等同于服务器 Shell 权限（后端以 root 运行且不做路径/命令限制），授予非管理员前请评估风险。
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '使用云端终端', 'terminal:use', '在云端任务中打开服务器交互式终端（等同服务器 Shell 权限）'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'terminal:use');

INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT 1, id FROM `permission` WHERE `code` = 'terminal:use'
  AND NOT EXISTS (SELECT 1 FROM `role_permission` WHERE `role_id` = 1 AND `permission_id` = `permission`.`id`);
