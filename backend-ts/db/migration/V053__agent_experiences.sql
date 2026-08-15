CREATE TABLE IF NOT EXISTS `agent_experiences` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `agent_id`    BIGINT NOT NULL COMMENT '所属 Agent ID',
    `content`     VARCHAR(300) NOT NULL COMMENT '经验正文，最长 300 字',
    `sort_order`  INT NOT NULL DEFAULT 0 COMMENT '排序，升序',
    `enabled`     TINYINT NOT NULL DEFAULT 1 COMMENT '1-启用 0-停用；停用不注入 Prompt',
    `created_at`  DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_agent_experiences_agent` (`agent_id`),
    INDEX `idx_agent_experiences_agent_sort` (`agent_id`, `sort_order`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Agent 最佳实践经验';
