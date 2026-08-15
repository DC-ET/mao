-- Add supports_vision column to llm_model for image upload feature
ALTER TABLE `llm_model` ADD COLUMN `supports_vision` TINYINT DEFAULT 0 COMMENT '是否支持视觉/图片输入 0=否 1=是';
