-- 删除 llm_model 表的历史遗留字段：max_tokens、temperature_max
-- 两者在代码（backend-ts/admin/desktop）中均无任何引用，属于旧版模型配置残留。
-- 注意：TS 后端 Flyway 通过 mysql2 直接执行 SQL，不支持 DELIMITER/存储过程语法。

ALTER TABLE `llm_model` DROP COLUMN `max_tokens`;
ALTER TABLE `llm_model` DROP COLUMN `temperature_max`;
