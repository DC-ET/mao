-- V017: 移除 Hub 功能相关表和字段

-- 删除 Hub 相关表
DROP TABLE IF EXISTS `agent_comment`;
DROP TABLE IF EXISTS `agent_rating`;
DROP TABLE IF EXISTS `hub_installation`;

-- 删除 Agent 表的 Hub 专属列 (idempotent)
DROP PROCEDURE IF EXISTS drop_hub_agent_columns;
DELIMITER //
CREATE PROCEDURE drop_hub_agent_columns()
BEGIN
    IF EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent' AND COLUMN_NAME = 'category') THEN
        ALTER TABLE `agent` DROP COLUMN `category`;
    END IF;
    IF EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent' AND COLUMN_NAME = 'published_at') THEN
        ALTER TABLE `agent` DROP COLUMN `published_at`;
    END IF;
END //
DELIMITER ;
CALL drop_hub_agent_columns();
DROP PROCEDURE drop_hub_agent_columns;

-- 删除 Hub 权限
DELETE FROM `role_permission` WHERE `permission_id` = (SELECT `id` FROM `permission` WHERE `code` = 'hub:write');
DELETE FROM `permission` WHERE `code` = 'hub:write';
