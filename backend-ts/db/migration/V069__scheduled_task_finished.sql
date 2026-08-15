-- 定时任务完结状态：显式记录"不再自动触发"的生命周期终态
ALTER TABLE scheduled_task
    ADD COLUMN finished    TINYINT  NOT NULL DEFAULT 0 COMMENT '是否已执行完结：1=已完结(不再自动触发)，0=进行中',
    ADD COLUMN finished_at DATETIME          DEFAULT NULL COMMENT '完结时间';

-- 存量数据：已执行完的一次性任务（无下次触发且已至少触发一次）置为已完结
UPDATE scheduled_task
SET finished    = 1,
    finished_at = COALESCE(last_fire_time, updated_at)
WHERE deleted = 0
  AND next_fire_time IS NULL
  AND fire_count > 0;
