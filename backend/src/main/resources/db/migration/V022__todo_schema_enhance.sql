-- V022: 增强 session_todo 表结构，支持任务详细描述、进行时描述、排序、多 Agent 协作

ALTER TABLE `session_todo`
    ADD COLUMN `description` VARCHAR(4096) DEFAULT '' COMMENT '任务详细描述，供 Agent 深入理解任务上下文',
    ADD COLUMN `active_form` VARCHAR(256) DEFAULT '' COMMENT '进行时描述，如 Fixing auth bug',
    ADD COLUMN `sort_order` INT DEFAULT 0 COMMENT '排序序号，支持用户拖拽调整优先级',
    ADD COLUMN `owner` VARCHAR(128) DEFAULT NULL COMMENT '任务归属 Agent（多 Agent 场景）',
    ADD COLUMN `claimed_at` DATETIME DEFAULT NULL COMMENT '任务领取时间（多 Agent 场景）',
    ADD COLUMN `blocked_by` JSON DEFAULT NULL COMMENT '依赖的任务 ID 列表，形成 DAG 阻塞关系';
