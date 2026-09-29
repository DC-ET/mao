-- 群消息富化未完成标记：图片/文件/卡片占位行在内容回填完成前为 1。
-- 上下文水位线不得越过未富化行，否则回填后的内容永远进不了群上下文。
ALTER TABLE `feishu_group_message_log`
  ADD COLUMN `enrich_pending` TINYINT NOT NULL DEFAULT 0 COMMENT '1=图片/文件/卡片内容尚未回填';
ALTER TABLE `feishu_group_message_log`
  ADD KEY `idx_group_msg_enrich` (`app_id`, `chat_id`, `enrich_pending`);

-- 话题上下文水位线与群级 feishu_chat.last_context_log_id 分维度，
-- 避免非话题触发把话题消息（或反向）从增量注入中永久跳过。
ALTER TABLE `feishu_thread_session`
  ADD COLUMN `last_context_log_id` BIGINT NOT NULL DEFAULT 0 COMMENT '话题上下文增量注入水位线';
