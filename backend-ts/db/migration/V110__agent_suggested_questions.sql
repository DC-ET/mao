CREATE TABLE IF NOT EXISTS `agent_suggested_questions` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `agent_id`    BIGINT NOT NULL COMMENT '所属 Agent ID',
    `content`     VARCHAR(100) NOT NULL COMMENT '问题正文，最长 100 字',
    `sort_order`  INT NOT NULL DEFAULT 0 COMMENT '排序，升序',
    `created_at`  DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_agent_suggested_questions_agent` (`agent_id`),
    INDEX `idx_agent_suggested_questions_agent_sort` (`agent_id`, `sort_order`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Agent 推荐问题';
