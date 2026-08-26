-- 群聊上下文增量注入水位线：记录上次注入上下文时已覆盖的最大群消息 log id，
-- 后续触发只注入该水位线之后的新增普通消息，避免历史消息反复进入用户消息。
ALTER TABLE feishu_chat ADD COLUMN last_context_log_id BIGINT NOT NULL DEFAULT 0;

-- 群消息中的文件原始文件名（图片为空），供上下文注入时落盘命名。
ALTER TABLE feishu_group_message_log ADD COLUMN file_name VARCHAR(256) NULL;
