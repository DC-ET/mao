-- V016: 移除 Hub 功能相关表和字段

-- 删除 Hub 相关表
DROP TABLE IF EXISTS `agent_comment`;
DROP TABLE IF EXISTS `agent_rating`;
DROP TABLE IF EXISTS `hub_installation`;

-- 删除 Agent 表的 Hub 专属列
ALTER TABLE `agent` DROP COLUMN `category`;
ALTER TABLE `agent` DROP COLUMN `published_at`;

-- 删除 Hub 权限
DELETE FROM `role_permission` WHERE `permission_id` = (SELECT `id` FROM `permission` WHERE `code` = 'hub:write');
DELETE FROM `permission` WHERE `code` = 'hub:write';
