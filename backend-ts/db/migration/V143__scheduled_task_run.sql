-- 定时任务运行历史：一行一个触发点（task_id + fire_time 唯一），重试覆盖同一行。
CREATE TABLE IF NOT EXISTS `scheduled_task_run` (
    `id`                BIGINT       NOT NULL AUTO_INCREMENT,
    `task_id`           BIGINT       NOT NULL COMMENT '所属定时任务',
    `fire_time`         DATETIME     NOT NULL COMMENT '计划触发点（cron 档期，Asia/Shanghai）',
    `attempt`           INT          NOT NULL DEFAULT 1 COMMENT '第几次尝试（重试递增，补偿补跑从 1 起）',
    `status`            VARCHAR(20)  NOT NULL DEFAULT 'RUNNING' COMMENT 'RUNNING/QUEUED/COMPLETED/FAILED/CANCELLED/MISSED',
    `session_id`        BIGINT       NOT NULL COMMENT '执行会话（任务绑定会话）',
    `message_id`        BIGINT       NULL COMMENT '锚点 USER 消息 id（成本/耗时窗口起点；排队路径为空）',
    `started_at`        DATETIME     NULL COMMENT '实际开跑时刻（排队路径为空）',
    `finished_at`       DATETIME     NULL COMMENT '终态时刻',
    `duration_ms`       BIGINT       NULL COMMENT '执行耗时：窗口 llm_call 墙钟聚合，无调用回落 finished-started',
    `cost_micros`       BIGINT       NULL COMMENT '窗口内 llm_call 成本合计（x1e6）；任一行未配价为 NULL',
    `error_summary`     VARCHAR(500) NULL COMMENT '最近一次 attempt 的错误摘要',
    `next_retry_at`     DATETIME     NULL COMMENT '下次重试时刻（无待重试为 NULL）',
    `queue_seq`         BIGINT       NULL COMMENT '进入 QUEUED 的顺序；结算按它 FIFO，不用自增 id',
    `created_at`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_task_run_fire` (`task_id`, `fire_time`),
    KEY `idx_task_run_status_retry` (`status`, `next_retry_at`),
    KEY `idx_task_run_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='定时任务运行记录';
