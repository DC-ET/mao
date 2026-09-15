-- 飞书话题群多会话：话题 → 会话映射表
-- 一个话题 (thread_id) 对应一个 Mao 会话；root_message_id 用于 reply API 回复话题根消息。
CREATE TABLE IF NOT EXISTS `feishu_thread_session` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `app_id` VARCHAR(64) NOT NULL COMMENT '飞书 bot id（feishu_bot.id 的字符串形态）',
  `chat_id` VARCHAR(128) NOT NULL COMMENT '群 ID (oc_xxx)',
  `thread_id` VARCHAR(64) NOT NULL COMMENT '话题 ID (omt_xxx)',
  `root_message_id` VARCHAR(64) NOT NULL COMMENT '话题根消息 message_id（reply API 的目标）',
  `session_id` BIGINT NOT NULL COMMENT '归属的 mao 会话 id',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_feishu_thread_session` (`app_id`, `thread_id`),
  KEY `idx_feishu_thread_session_chat` (`app_id`, `chat_id`),
  KEY `idx_feishu_thread_session_session` (`app_id`, `session_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '飞书话题→会话映射';

-- 群消息日志新增 thread_id 列：话题内上下文按 thread_id 过滤注入。
ALTER TABLE `feishu_group_message_log` ADD COLUMN `thread_id` VARCHAR(64) NULL COMMENT '话题 ID (omt_xxx)';
ALTER TABLE `feishu_group_message_log` ADD KEY `idx_group_msg_thread` (`app_id`, `chat_id`, `thread_id`);
