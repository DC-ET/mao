-- V040__subagent_delegation.sql
-- 子智能体委派支持：session 父子关系、message 来源追踪、执行审计表

-- 1. session 表新增父子关系字段
ALTER TABLE `session`
    ADD COLUMN `parent_session_id` BIGINT DEFAULT NULL COMMENT '父会话 ID，子智能体使用'
        AFTER `unread`,
    ADD COLUMN `session_type` VARCHAR(20) DEFAULT 'NORMAL' COMMENT '会话类型: NORMAL/SUBAGENT'
        AFTER `parent_session_id`;

CREATE INDEX idx_session_parent ON `session`(`parent_session_id`);

-- 2. session 表 phase 字段允许 NULL（子智能体会话不使用 phase 状态机）
ALTER TABLE `session`
    MODIFY COLUMN `phase` VARCHAR(20) DEFAULT NULL COMMENT '任务阶段，子智能体会话不使用';

-- 3. message 表新增来源会话标记
ALTER TABLE `message`
    ADD COLUMN `source_session_id` BIGINT DEFAULT NULL COMMENT '消息来源会话 ID，子智能体结果注入时使用'
        AFTER `metadata`;

CREATE INDEX idx_message_source ON `message`(`source_session_id`);

-- 4. 子智能体执行记录表
CREATE TABLE IF NOT EXISTS `subagent_execution` (
    `id`                      BIGINT AUTO_INCREMENT PRIMARY KEY,
    `parent_session_id`       BIGINT NOT NULL COMMENT '父会话 ID',
    `child_session_id`        BIGINT NOT NULL COMMENT '子会话 ID',
    `task_description`        TEXT COMMENT '任务描述',
    `result`                  MEDIUMTEXT COMMENT '最终结果',
    `status`                  VARCHAR(20) NOT NULL DEFAULT 'RUNNING' COMMENT '状态: RUNNING/COMPLETED/FAILED/CANCELLED',
    `total_rounds`            INT DEFAULT 0 COMMENT '执行轮次',
    `total_prompt_tokens`     INT DEFAULT 0 COMMENT 'prompt token 消耗',
    `total_completion_tokens` INT DEFAULT 0 COMMENT 'completion token 消耗',
    `started_at`              DATETIME DEFAULT CURRENT_TIMESTAMP,
    `completed_at`            DATETIME,
    `created_at`              DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`              DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_sae_parent (`parent_session_id`),
    INDEX idx_sae_child (`child_session_id`),
    INDEX idx_sae_status (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='子智能体执行记录';
