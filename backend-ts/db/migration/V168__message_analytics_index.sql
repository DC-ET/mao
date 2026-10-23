-- V168: 用量分析 message 聚合覆盖索引
--
-- 管理后台「用量分析」总览 / 用户 / Agent / 模型 / 会话各 Tab 都要按时间窗对 message 做
-- COUNT(*) / SUM(token_count) 聚合。原先只有 idx_created(created_at)：
--   * SUM(token_count) 不能只读索引，必须回表读 content（表约 40 万行 / 2.1GB），
--     7 / 30 / 90 天窗口实测 0.38 / 0.41 / 0.56s；
--   * 按用户 / Agent / 模型分组时优化器还会选「以 session 为驱动、逐会话回查 message」
--     的计划（30 天实测 1.15s）。
-- 覆盖索引把窗口聚合变成纯索引区间扫描（实测 7d 0.10s / 30d 0.18s / 90d 0.22s），
-- 也不再因为扫正文页把 buffer pool 里的热点数据挤出去。

DROP PROCEDURE IF EXISTS add_message_analytics_index;
DELIMITER //
CREATE PROCEDURE add_message_analytics_index()
BEGIN
    IF NOT EXISTS (SELECT * FROM INFORMATION_SCHEMA.STATISTICS
                   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'message'
                     AND INDEX_NAME = 'idx_message_created_stats') THEN
        ALTER TABLE `message`
            ADD INDEX `idx_message_created_stats` (`created_at`, `deleted`, `token_count`, `session_id`, `model_id`),
            ALGORITHM=INPLACE, LOCK=NONE;
    END IF;

    -- 新索引以 created_at 为最左前缀，旧单列索引完全冗余；下线减少热表写放大。
    IF EXISTS (SELECT * FROM INFORMATION_SCHEMA.STATISTICS
               WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'message'
                 AND INDEX_NAME = 'idx_created') THEN
        ALTER TABLE `message` DROP INDEX `idx_created`, ALGORITHM=INPLACE, LOCK=NONE;
    END IF;
END //
DELIMITER ;
CALL add_message_analytics_index();
DROP PROCEDURE add_message_analytics_index;
