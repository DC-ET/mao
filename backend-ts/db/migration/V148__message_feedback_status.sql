-- 点踩反馈处理态：PENDING 待处理 / CONVERTED 已转为经验 / DISMISSED 已忽略。
-- 后两者为终态，不可互相流转、不可回退（技术方案 2026-10-11-feedback-experience-loop §4.1）。
-- 存量行经列默认值回填为 PENDING，无需数据订正（与 V125 source 列同款处理）。

ALTER TABLE `message_feedback`
    ADD COLUMN `status` VARCHAR(16) NOT NULL DEFAULT 'PENDING'
        COMMENT 'PENDING 待处理 / CONVERTED 已转为经验 / DISMISSED 已忽略；后两者为终态' AFTER `source`,
    ADD COLUMN `handled_by` BIGINT NULL COMMENT '处理人（管理员 user_id）' AFTER `status`,
    ADD COLUMN `handled_at` DATETIME NULL COMMENT '处理时间' AFTER `handled_by`,
    ADD COLUMN `experience_id` BIGINT NULL COMMENT 'CONVERTED 时关联的 agent_experiences.id（一次转换写多条时只记第一条）' AFTER `handled_at`;

-- 待处理清单与聚集计数的主路径：按 status 过滤后按 agent + reason 分组计数。
CREATE INDEX `idx_feedback_pending` ON `message_feedback` (`status`, `agent_id`, `reason`, `created_at`);
