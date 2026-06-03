-- V026: Remove bash tool — shell is now the only command execution tool.
-- Tools are purely in-memory via ToolRegistry (see V024), so this only cleans up the skill table if it exists.

DROP PROCEDURE IF EXISTS remove_bash_tool;
DELIMITER //
CREATE PROCEDURE remove_bash_tool()
BEGIN
    IF EXISTS (SELECT 1 FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'skill') THEN
        DELETE FROM `skill` WHERE `name` = 'bash';
    END IF;
END //
DELIMITER ;
CALL remove_bash_tool();
DROP PROCEDURE remove_bash_tool;
