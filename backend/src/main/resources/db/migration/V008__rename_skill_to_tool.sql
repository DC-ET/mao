-- V008: Rename Skill -> Tool, introduce Anthropic-style Skill knowledge documents

DROP PROCEDURE IF EXISTS migrate_skill_to_tool;
DELIMITER //
CREATE PROCEDURE migrate_skill_to_tool()
BEGIN
    -- 1. Rename skill table to tool (only if skill exists and tool doesn't)
    IF EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'skill')
       AND NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tool') THEN
        RENAME TABLE `skill` TO `tool`;
    END IF;

    -- 2. Rename agent_skill table to agent_tool (only if agent_skill exists and agent_tool doesn't)
    IF EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_skill')
       AND NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_tool') THEN
        RENAME TABLE `agent_skill` TO `agent_tool`;
    END IF;

    -- 3. Update agent_tool foreign key column name (only if skill_id exists)
    IF EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_tool' AND COLUMN_NAME = 'skill_id') THEN
        ALTER TABLE `agent_tool` CHANGE COLUMN `skill_id` `tool_id` BIGINT NOT NULL;
    END IF;

    -- 4. Update unique key (drop old, add new)
    IF EXISTS (SELECT * FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_tool' AND INDEX_NAME = 'uk_agent_skill') THEN
        ALTER TABLE `agent_tool` DROP KEY `uk_agent_skill`;
    END IF;
    IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent_tool' AND INDEX_NAME = 'uk_agent_tool') THEN
        ALTER TABLE `agent_tool` ADD UNIQUE KEY `uk_agent_tool` (`agent_id`, `tool_id`);
    END IF;

    -- 5. Update impl_class to reflect new package paths (only if tool table exists)
    IF EXISTS (SELECT * FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tool') THEN
        UPDATE `tool` SET `impl_class` = REPLACE(`impl_class`, '.skill.impl.', '.tool.impl.') WHERE `impl_class` LIKE '%.skill.impl.%';
        UPDATE `tool` SET `impl_class` = REPLACE(`impl_class`, 'BashSkill', 'BashTool') WHERE `impl_class` LIKE '%BashSkill%';
        UPDATE `tool` SET `impl_class` = REPLACE(`impl_class`, 'ReadFileSkill', 'ReadFileTool') WHERE `impl_class` LIKE '%ReadFileSkill%';
        UPDATE `tool` SET `impl_class` = REPLACE(`impl_class`, 'WriteFileSkill', 'WriteFileTool') WHERE `impl_class` LIKE '%WriteFileSkill%';
        UPDATE `tool` SET `impl_class` = REPLACE(`impl_class`, 'EditFileSkill', 'EditFileTool') WHERE `impl_class` LIKE '%EditFileSkill%';
        UPDATE `tool` SET `impl_class` = REPLACE(`impl_class`, 'HttpRequestSkill', 'HttpRequestTool') WHERE `impl_class` LIKE '%HttpRequestSkill%';
        UPDATE `tool` SET `impl_class` = REPLACE(`impl_class`, 'TodoSkill', 'TodoTool') WHERE `impl_class` LIKE '%TodoSkill%';
        UPDATE `tool` SET `impl_class` = REPLACE(`impl_class`, 'SubagentSkill', 'SubagentTool') WHERE `impl_class` LIKE '%SubagentSkill%';
    END IF;

    -- 6. Agent table: add skill_names for Anthropic-style Skill knowledge documents
    IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'agent' AND COLUMN_NAME = 'skill_names') THEN
        ALTER TABLE `agent` ADD COLUMN `skill_names` JSON DEFAULT NULL COMMENT '可用的 Skill 知识文档名称列表，为空则加载全部';
    END IF;
END //
DELIMITER ;
CALL migrate_skill_to_tool();
DROP PROCEDURE migrate_skill_to_tool;
