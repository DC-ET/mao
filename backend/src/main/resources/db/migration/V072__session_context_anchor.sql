-- V072: 会话上下文 token 锚点（真实 prompt_tokens + 边界消息 id）

ALTER TABLE `session`
    ADD COLUMN `last_prompt_tokens` INT DEFAULT 0 COMMENT '最近一次 LLM 真实 prompt_tokens 锚点' AFTER `context_tokens`,
    ADD COLUMN `context_anchor_msg_id` BIGINT DEFAULT 0 COMMENT '锚点覆盖到的最后一条消息 ID' AFTER `last_prompt_tokens`;
