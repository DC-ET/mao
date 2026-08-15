-- V028: remove obsolete agent.type column

SET @column_exists := (
    SELECT COUNT(*)
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'agent'
      AND COLUMN_NAME = 'type'
);

SET @ddl := IF(@column_exists > 0,
    'ALTER TABLE `agent` DROP COLUMN `type`',
    'SELECT 1'
);

PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
