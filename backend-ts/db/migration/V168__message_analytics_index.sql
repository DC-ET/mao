-- V168: 用量分析 message 聚合覆盖索引
--
-- 管理后台「用量分析」总览 / 用户 / Agent / 模型 / 会话各 Tab 都要按时间窗对 message 做
-- COUNT(*) / SUM(token_count) 聚合。原先只有 idx_created(created_at)：
--   * SUM(token_count) 不能只读索引，必须回表读 content（表约 40 万行 / 2.1GB），
--     7 / 30 / 90 天窗口实测 0.38 / 0.41 / 0.56s；
--   * 按用户 / Agent / 模型分组时优化器还会选「以 session 为驱动、逐会话回查 message」的
--     计划（30 天实测 1.15s）。
-- 覆盖索引把窗口聚合变成纯索引区间扫描（实测 7d 0.10s / 30d 0.18s / 90d 0.22s），
-- 也不再因为扫正文页把 buffer pool 里的热点数据挤出去。
--
-- 注意：TS 后端 Flyway 通过 mysql2 逐条下发整段 SQL，不支持 DELIMITER / 存储过程，
-- 因此条件 DDL 用 SET @ddl + PREPARE 动态 SQL 表达（与 V080 同范式）。
-- 开头的 DELETE 仅作占位语句，规避 mysql2 对 SET 开头多语句的解析问题，无实际作用。

DELETE FROM `message` WHERE 0;
SET @add_stats_index := (
    SELECT IF(COUNT(*) > 0,
        'DELETE FROM `message` WHERE 0',
        'ALTER TABLE `message` ADD INDEX `idx_message_created_stats` (`created_at`, `deleted`, `token_count`, `session_id`, `model_id`), ALGORITHM=INPLACE, LOCK=NONE')
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'message'
      AND INDEX_NAME = 'idx_message_created_stats'
);
PREPARE add_stats_index FROM @add_stats_index;
EXECUTE add_stats_index;
DEALLOCATE PREPARE add_stats_index;

-- 新索引以 created_at 为最左前缀，旧单列索引完全冗余；下线减少热表写放大。
DELETE FROM `message` WHERE 0;
SET @drop_created_index := (
    SELECT IF(COUNT(*) > 0,
        'ALTER TABLE `message` DROP INDEX `idx_created`, ALGORITHM=INPLACE, LOCK=NONE',
        'DELETE FROM `message` WHERE 0')
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'message'
      AND INDEX_NAME = 'idx_created'
);
PREPARE drop_created_index FROM @drop_created_index;
EXECUTE drop_created_index;
DEALLOCATE PREPARE drop_created_index;
