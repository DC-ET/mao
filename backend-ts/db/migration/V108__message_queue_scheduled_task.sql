-- 定时任务 busy 入队后，队列消费侧需回写 lastExecutionStatus。
-- 在 message_queue 上绑定来源 scheduled_task_id，autoConsume 成功后 CAS 回写 QUEUED → COMPLETED/FAILED。
ALTER TABLE message_queue
    ADD COLUMN scheduled_task_id BIGINT NULL AFTER status;

CREATE INDEX idx_scheduled_task_id ON message_queue (scheduled_task_id);
