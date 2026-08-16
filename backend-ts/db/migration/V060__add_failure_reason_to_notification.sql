ALTER TABLE `task_notification_delivery`
    ADD COLUMN `failure_reason` VARCHAR(500) NULL COMMENT '任务失败原因' AFTER `title_snapshot`;
