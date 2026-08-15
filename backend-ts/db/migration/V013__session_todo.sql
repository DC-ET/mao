-- V013: session_todo 表，持久化存储会话级 TODO 任务列表
-- 替代原 TodoTool 的内存 ConcurrentHashMap 存储，支持会话恢复

CREATE TABLE IF NOT EXISTS `session_todo` (
    `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
    `session_id` BIGINT NOT NULL,
    `content`    VARCHAR(1024) NOT NULL DEFAULT '',
    `status`     VARCHAR(20) NOT NULL DEFAULT 'pending',
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_session` (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
