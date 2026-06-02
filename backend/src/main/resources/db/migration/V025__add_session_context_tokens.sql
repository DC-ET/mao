-- V025: 持久化会话上下文 token 数
ALTER TABLE `session` ADD COLUMN `context_tokens` INT DEFAULT 0 COMMENT '最近一次 LLM 调用的上下文 token 估算值';
