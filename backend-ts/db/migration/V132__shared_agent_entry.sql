-- 团队共享目录（Agent 资产化 P2）：
-- 管理员将启用中的 Agent 上架（推荐语 + 排序），工作台 Agent 选择器顶部展示"团队共享"分区。
-- 无外键：Agent 删除（逻辑删）时在服务层级联删除条目；停用保留条目，启用过滤自然隐藏。
CREATE TABLE IF NOT EXISTS `shared_agent_entry` (
    `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
    `agent_id`   BIGINT NOT NULL,
    `note`       VARCHAR(512) NOT NULL DEFAULT '' COMMENT '推荐语：适合什么任务、怎么用',
    `sort_order` INT NOT NULL DEFAULT 0,
    `created_by` BIGINT NOT NULL,
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_shared_agent` (`agent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='团队共享 Agent 目录条目';
