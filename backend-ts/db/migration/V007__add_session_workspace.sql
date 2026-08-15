-- V007: Add workspace directory to session table
-- Used by LOCAL execution mode to define the root directory for tool operations
DROP PROCEDURE IF EXISTS add_workspace;
DELIMITER //
CREATE PROCEDURE add_workspace()
BEGIN
    IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'session' AND COLUMN_NAME = 'workspace') THEN
        ALTER TABLE `session` ADD COLUMN `workspace` VARCHAR(512) DEFAULT NULL;
    END IF;
END //
DELIMITER ;
CALL add_workspace();
DROP PROCEDURE add_workspace;
