-- V188: 会话管理列表新增「活跃时间」范围筛选（默认最近 7 天），补 last_activity_at 索引。
-- 背景：关键词搜索此前走全局消息检索，message 表 68 万行时单次 70~80s 触发前端超时；
-- 现在会话先按 last_activity_at 收敛到时间窗，再在窗口内消息里匹配。
-- last_activity_at 此前无索引：该列既作范围条件又是列表排序键（ORDER BY last_activity_at DESC, id DESC），
-- (last_activity_at, id) 可同时支撑范围扫描与排序 tiebreaker。session 表约 2k 行，加索引为原地 DDL、秒级完成。
-- 说明：当前数据量下全表扫描本身很快，该索引的价值在会话量增长后避免范围扫描退化成全表 + filesort。
ALTER TABLE `session`
  ADD INDEX `idx_session_last_activity` (`last_activity_at`, `id`);

-- 逆运算（如需回滚）：
--   ALTER TABLE `session` DROP INDEX `idx_session_last_activity`;
