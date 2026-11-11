-- 钉钉互动卡片一卡到底（技术方案 2026-11-11-dingtalk-card-single-card-technical-design §5.6）：
-- 排队/进度/终态共用同一模板，`dingtalk_bot` 收敛为单列 `card_template_id`。
-- 不做存量兼容（前置约定）：不回填旧值，上线后由用户在后台重新填一次；未填时卡片退化为文本进度。
ALTER TABLE `dingtalk_bot`
    ADD COLUMN `card_template_id` VARCHAR(128) NULL COMMENT '钉钉互动卡片模板ID（排队/进度/终态共用同一模板）' AFTER `model_id`;

ALTER TABLE `dingtalk_bot` DROP COLUMN `queue_card_template_id`;
ALTER TABLE `dingtalk_bot` DROP COLUMN `progress_card_template_id`;
