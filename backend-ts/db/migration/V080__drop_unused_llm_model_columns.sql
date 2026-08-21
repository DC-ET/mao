-- 删除 llm_model 表的历史遗留字段：max_tokens、temperature_max
-- 两者在代码（backend-ts/admin/desktop）中均无任何引用，属于旧版模型配置残留。
-- 注意：TS 后端 Flyway 通过 mysql2 直接执行 SQL，不支持 DELIMITER/存储过程语法；
-- 不同环境该表数据状态不一（列可能已不存在），故用动态 SQL 做条件 DROP。
-- 开头的 DELETE 仅为占位语句，用于规避 mysql2 对 SET 开头多语句的解析问题，无实际作用。

DELETE FROM llm_model WHERE 0;
SET @drop_max_tokens := (
    SELECT IF(COUNT(*) > 0, 'ALTER TABLE `llm_model` DROP COLUMN `max_tokens`', 'DELETE FROM llm_model WHERE 0')
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'llm_model' AND COLUMN_NAME = 'max_tokens'
);
PREPARE drop_max_tokens FROM @drop_max_tokens;
EXECUTE drop_max_tokens;
DEALLOCATE PREPARE drop_max_tokens;

DELETE FROM llm_model WHERE 0;
SET @drop_temperature_max := (
    SELECT IF(COUNT(*) > 0, 'ALTER TABLE `llm_model` DROP COLUMN `temperature_max`', 'DELETE FROM llm_model WHERE 0')
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'llm_model' AND COLUMN_NAME = 'temperature_max'
);
PREPARE drop_temperature_max FROM @drop_temperature_max;
EXECUTE drop_temperature_max;
DEALLOCATE PREPARE drop_temperature_max;
