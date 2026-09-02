-- 一次性定时任务：cron 固定「日+月」（如 0 0 8 15 8 ?）只会执行一次，
-- 但 croner 对此类表达式算出的 next 永远是明年同一天，导致执行完后仍长期 ACTIVE。
-- 增加 once 列显式标记，执行一次后自动置 finished。

ALTER TABLE scheduled_task
    ADD COLUMN once TINYINT NOT NULL DEFAULT 0 COMMENT '一次性任务：1=执行一次后自动完结';

-- 存量修复：已触发过的一次性任务（固定月+日且无周字段、fire_count>0、未完结）置为已完结并清掉明年同日的虚假 next_fire_time
UPDATE scheduled_task
SET finished       = 1,
    finished_at    = COALESCE(last_fire_time, updated_at),
    next_fire_time = NULL,
    once           = 1
WHERE deleted = 0
  AND finished = 0
  AND fire_count > 0
  AND cron_expression REGEXP '^([0-9*/,-]+[[:space:]]+){3}[0-9]+[[:space:]]+[0-9]+[[:space:]]+[?*]$';

-- 其余一次性任务（尚未触发）补打 once 标记
UPDATE scheduled_task
SET once = 1
WHERE deleted = 0
  AND once = 0
  AND cron_expression REGEXP '^([0-9*/,-]+[[:space:]]+){3}[0-9]+[[:space:]]+[0-9]+[[:space:]]+[?*]$';
