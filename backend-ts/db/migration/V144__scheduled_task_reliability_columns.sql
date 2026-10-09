-- 定时任务可靠性：重试策略、错过补偿、连续失败计数。存量任务靠 DEFAULT 获得默认行为。
ALTER TABLE `scheduled_task`
    ADD COLUMN `consecutive_failures`   INT         NOT NULL DEFAULT 0 COMMENT '连续失败计数：FAILED+1 / COMPLETED 清零 / 达阈值自动暂停 / 手动启用重置',
    ADD COLUMN `retry_max`              INT         NOT NULL DEFAULT 2 COMMENT '失败后最大重试次数（不含首次），0=不重试，上限 5',
    ADD COLUMN `retry_interval_minutes` INT         NOT NULL DEFAULT 5 COMMENT '重试间隔（分钟，固定），范围 1-60',
    ADD COLUMN `missed_policy`          VARCHAR(20) NOT NULL DEFAULT 'RUN_ONCE' COMMENT '错过补偿策略：RUN_ONCE 补最近一次 | SKIP 只记录不补';
