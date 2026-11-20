-- 飞书媒体消息 reply 锚点：记录本轮执行的触发消息 ID（runExecution 开始写入、结束清空）。
-- NULL = 无触发消息（主动推送：定时任务 / 排队之外的 Webhook 等），发送侧回退「最新入站」旧口径。
-- 不回填存量；不加索引（读取恒按 uk_feishu_session_channel(session_id) 命中一行）。
ALTER TABLE `feishu_session_channel`
  ADD COLUMN `last_trigger_message_id` VARCHAR(128) NULL
  COMMENT '本轮执行的触发消息 ID（图片/文件 reply 锚点，轮次结束清空）'
  AFTER `awaiting_first_message_title`;
