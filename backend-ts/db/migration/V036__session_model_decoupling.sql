-- session 表增加 model_id（可 NULL，NULL 表示使用默认模型）
ALTER TABLE `session` ADD COLUMN `model_id` BIGINT NULL COMMENT '当前会话使用的模型 ID，NULL 表示使用默认模型';

-- llm_model 表增加 is_default
ALTER TABLE `llm_model` ADD COLUMN `is_default` TINYINT NOT NULL DEFAULT 0 COMMENT '是否默认模型：0=否 1=是';

-- 将当前 Agent 绑定的模型设为默认
UPDATE `llm_model` SET `is_default` = 1
WHERE `id` = (SELECT `model_id` FROM `agent` WHERE `model_id` IS NOT NULL LIMIT 1);

-- 删除 agent 表的 model_id 列
ALTER TABLE `agent` DROP COLUMN `model_id`;
