-- 删除 llm_model 表的历史遗留字段：max_tokens、temperature_max
-- 两者在代码（backend-ts/admin/desktop）中均无任何引用，属于旧版模型配置残留。

DROP PROCEDURE IF EXISTS drop_unused_llm_model_columns;
DELIMITER //
CREATE PROCEDURE drop_unused_llm_model_columns()
BEGIN
    IF EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'llm_model' AND COLUMN_NAME = 'max_tokens') THEN
        ALTER TABLE `llm_model` DROP COLUMN `max_tokens`;
    END IF;
    IF EXISTS (SELECT * FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'llm_model' AND COLUMN_NAME = 'temperature_max') THEN
        ALTER TABLE `llm_model` DROP COLUMN `temperature_max`;
    END IF;
END //
DELIMITER ;
CALL drop_unused_llm_model_columns();
DROP PROCEDURE drop_unused_llm_model_columns;
