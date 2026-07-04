-- V043__add_side_task_support.sql
-- 边路任务（Side Task）支持：session_type 扩展、phase 字段允许 NULL

-- 1. 确保 session_type 支持 'side_task' 值
--    V040 已增加 session_type 列（NORMAL/SUBAGENT），此处扩展支持 side_task
ALTER TABLE `session`
    MODIFY COLUMN `session_type` VARCHAR(20) DEFAULT 'NORMAL'
    COMMENT '会话类型: NORMAL/SUBAGENT/SIDE_TASK';

-- 2. 确认 phase 字段可为 NULL（边路任务不使用 phase 中间状态）
--    V040 已处理，此处作为保底
ALTER TABLE `session`
    MODIFY COLUMN `phase` VARCHAR(20) DEFAULT NULL
    COMMENT '任务阶段，边路任务/子智能体会话不使用';
