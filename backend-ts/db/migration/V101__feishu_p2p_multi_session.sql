-- 飞书私聊多会话：消息 → 会话归属映射表
-- 支持引用消息自动切换活跃会话（查 parentId 归属）、出站消息（文本回复/进度卡片/排队卡片）归属记录。
-- 活跃会话指针复用 feishu_chat.session_id（ON DUPLICATE KEY UPDATE），表结构不变。
CREATE TABLE IF NOT EXISTS `feishu_p2p_message` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `app_id` VARCHAR(64) NOT NULL COMMENT '飞书 bot id（feishu_bot.id 的字符串形态）',
  `message_id` VARCHAR(64) NOT NULL COMMENT '飞书消息 message_id（om_xxx），入站与出站消息统一',
  `session_id` BIGINT NOT NULL COMMENT '归属的 mao 会话 id',
  `direction` VARCHAR(8) NOT NULL DEFAULT 'IN' COMMENT 'IN=用户入站 / OUT=机器人出站（文本回复、进度卡片、排队卡片）',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_feishu_p2p_message` (`app_id`, `message_id`),
  KEY `idx_feishu_p2p_message_session` (`app_id`, `session_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '飞书私聊消息→会话归属映射';
