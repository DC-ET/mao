-- V044__fix_side_task_session_status.sql
-- 边路任务的执行状态应使用 phase 字段，status 保持 ACTIVE 表示会话未归档

UPDATE `session`
SET `status` = 'ACTIVE'
WHERE `session_type` = 'SIDE_TASK'
  AND `status` IN ('COMPLETED', 'FAILED', 'CANCELLED');
