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

-- 会话 → 飞书通道绑定（不可变）：会话创建时落一行，此后无论活跃指针怎么切，
-- 会话→(bot, chat) 的反查都以本表为准（多会话并行场景下 findConversationBySessionId 不再可用）。
CREATE TABLE IF NOT EXISTS `feishu_session_channel` (
  `id` BIGINT NOT NULL AUTO_INCREMENT,
  `session_id` BIGINT NOT NULL COMMENT 'mao 会话 id',
  `app_id` VARCHAR(64) NOT NULL COMMENT '飞书 bot id（feishu_bot.id 的字符串形态）',
  `chat_id` VARCHAR(255) NOT NULL COMMENT '飞书会话键：群聊 chat_id / 私聊 p2p:union:* 或 p2p:open:*',
  `chat_type` VARCHAR(8) NOT NULL DEFAULT 'p2p' COMMENT 'p2p / group',
  `awaiting_first_message_title` TINYINT NOT NULL DEFAULT 0 COMMENT '1=`---` 新建、等待首条消息按前 20 字命名（重启安全的持久化标志）',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_feishu_session_channel` (`session_id`),
  KEY `idx_feishu_session_channel_chat` (`app_id`, `chat_id`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COMMENT = '飞书会话→通道绑定（创建时落行，不可变）';

-- 存量回填：以 feishu_chat 当前指针行为准（群聊与私聊各一行即一个会话绑定）。
INSERT IGNORE INTO `feishu_session_channel` (`session_id`, `app_id`, `chat_id`, `chat_type`)
SELECT `session_id`, `app_id`, `chat_id`,
  CASE WHEN `chat_id` LIKE 'p2p:%' THEN 'p2p' ELSE 'group' END
FROM `feishu_chat`;
