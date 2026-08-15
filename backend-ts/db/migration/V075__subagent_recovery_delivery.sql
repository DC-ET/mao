ALTER TABLE `subagent_execution`
    ADD COLUMN `invocation_type` VARCHAR(20) DEFAULT NULL COMMENT '调用类型: DELEGATE/FOLLOWUP' AFTER `agent_type`,
    ADD COLUMN `parent_tool_call_id` VARCHAR(128) DEFAULT NULL COMMENT '父会话工具调用 ID' AFTER `invocation_type`,
    ADD COLUMN `delivery_status` VARCHAR(20) DEFAULT NULL COMMENT '父结果交付状态: PENDING/DELIVERED/SUPPRESSED/LEGACY' AFTER `parent_tool_call_id`,
    ADD COLUMN `parent_result_delivered_at` DATETIME DEFAULT NULL COMMENT '父结果交付完成时间' AFTER `delivery_status`,
    ADD COLUMN `parent_assistant_message_id` BIGINT DEFAULT NULL COMMENT '父 assistant 消息 ID' AFTER `parent_result_delivered_at`,
    ADD COLUMN `parent_tool_message_id` BIGINT DEFAULT NULL COMMENT '父 TOOL 消息 ID' AFTER `parent_assistant_message_id`,
    ADD COLUMN `execution_start_message_id` BIGINT DEFAULT NULL COMMENT '本次执行起始 USER 消息 ID' AFTER `parent_tool_message_id`,
    ADD COLUMN `final_message_id` BIGINT DEFAULT NULL COMMENT '本次执行最终 ASSISTANT 消息 ID' AFTER `execution_start_message_id`,
    ADD COLUMN `total_tool_calls` INT NOT NULL DEFAULT 0 COMMENT '本次执行工具调用数' AFTER `total_completion_tokens`;

UPDATE `subagent_execution`
SET `delivery_status` = CASE
    WHEN `status` = 'RUNNING' THEN 'PENDING'
    ELSE 'LEGACY'
END
WHERE `delivery_status` IS NULL;

ALTER TABLE `subagent_execution`
    MODIFY COLUMN `delivery_status` VARCHAR(20) NOT NULL DEFAULT 'PENDING' COMMENT '父结果交付状态: PENDING/DELIVERED/SUPPRESSED/LEGACY';

CREATE INDEX `idx_sae_recovery` ON `subagent_execution` (`status`, `delivery_status`);
CREATE UNIQUE INDEX `uk_sae_parent_tool_call` ON `subagent_execution` (`parent_session_id`, `parent_tool_call_id`);
