-- V161: 飞书完成卡终态快照（点踩归属与快照重建，技术方案 2026-10-20）。
-- 一行 = 一张 COMPLETED 完成卡：点击「不满意」时按被点卡片 message_id 反查该卡对应的
-- ASSISTANT 消息与终态快照（轮次/耗时/正文），进程重启后旧卡仍可完整重绘。
-- 与 feishu_progress_card 的分工：后者是「一会话一行 + 终态即删」的活跃映射，供崩溃恢复定位；
-- 本表按卡片唯一（uk 在 card_message_id），终态写入后长期保留。重试会为同一张卡覆盖快照行。
CREATE TABLE IF NOT EXISTS `feishu_card_snapshot` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `card_message_id` VARCHAR(128) NOT NULL COMMENT '被点击的进度卡片messageId',
    `session_id` BIGINT NOT NULL COMMENT '会话ID',
    `bot_id` BIGINT NOT NULL COMMENT '飞书Bot应用ID(feishu_bot.id)',
    `message_id` BIGINT NOT NULL COMMENT '卡片对应的最终ASSISTANT消息ID(message.id)',
    `status` VARCHAR(16) NOT NULL DEFAULT 'COMPLETED' COMMENT '卡片终态(仅COMPLETED有点踩按钮)',
    `round` INT NOT NULL DEFAULT 0 COMMENT '卡片展示轮次(共N轮)',
    `elapsed_ms` BIGINT NOT NULL DEFAULT 0 COMMENT '卡片展示耗时(毫秒,终态固化值)',
    `content` MEDIUMTEXT NULL COMMENT '卡片正文(与卡片同口径,截断6000字符)',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_feishu_card_snapshot_card` (`card_message_id`),
    KEY `idx_feishu_card_snapshot_session` (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='飞书完成卡终态快照(点踩归属与重绘)';
