-- 群聊上下文溢出摘要缓存：注入窗口之外被丢弃的更早消息（未注入部分）用 LLM 生成一次摘要，
-- 随【群内最近消息】注入并缓存于会话行；context_summary_log_id 为摘要已覆盖的最大群消息 log id，
-- 后续重放若溢出集合未变化则直接复用缓存，避免重复 LLM 调用。
ALTER TABLE feishu_chat ADD COLUMN context_summary TEXT NULL;
ALTER TABLE feishu_chat ADD COLUMN context_summary_log_id BIGINT NOT NULL DEFAULT 0;