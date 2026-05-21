-- V006: Add execution_mode to session table
-- Supports CLOUD (server-side tool execution) and LOCAL (client-side via WebSocket)
DROP PROCEDURE IF EXISTS add_execution_mode;
DELIMITER //
CREATE PROCEDURE add_execution_mode()
BEGIN
    IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'session' AND COLUMN_NAME = 'execution_mode') THEN
        ALTER TABLE `session` ADD COLUMN `execution_mode` VARCHAR(16) NOT NULL DEFAULT 'CLOUD';
    END IF;
END //
DELIMITER ;
CALL add_execution_mode();
DROP PROCEDURE add_execution_mode;
