-- V139: 用量预算管控（技术方案 §5.5）——usage_budget 表 + budget:* 权限码 + compaction.modelId 种子
-- + user_inbox_preference 预算提醒开关（默认开）。

CREATE TABLE IF NOT EXISTS `usage_budget` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `scope`       VARCHAR(16)  NOT NULL COMMENT 'GLOBAL/USER/AGENT',
    `scope_id`    BIGINT       NULL COMMENT 'USER/AGENT 时的目标 id；GLOBAL 为 NULL',
    `period`      VARCHAR(16)  NOT NULL DEFAULT 'MONTHLY',
    `limit_type`  VARCHAR(16)  NOT NULL COMMENT 'COST（微单位整数）/ TOKENS',
    `limit_value` BIGINT       NOT NULL COMMENT 'COST: cost_micros 口径；TOKENS: total_tokens 累计',
    `action`      VARCHAR(8)   NOT NULL COMMENT 'WARN/BLOCK',
    `enabled`     TINYINT      NOT NULL DEFAULT 1,
    `created_by`  BIGINT       NOT NULL,
    `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY `idx_budget_scope` (`scope`, `scope_id`, `enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用量预算（周期消耗上限）';

-- 权限码按 V121 目录模式注册，默认只授系统管理员（role_id=1）。
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '查看用量预算', 'budget:read', '查看用量预算与当期消耗'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'budget:read');
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '管理用量预算', 'budget:write', '创建、编辑、启停、删除用量预算'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'budget:write');

INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT 1, id FROM `permission`
WHERE `code` IN ('budget:read', 'budget:write');

-- compaction.modelId 种子（system_setting 仅 5 个业务列，与 V097 同款写法；类目沿用 V097 的「运行参数」）。
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('compaction.modelId', '', '运行参数', '上下文压缩摘要使用的模型；留空则使用会话模型', 1);

-- 预算提醒（BUDGET_WARN）偏好开关：默认开（成本越线是运维级提醒）。
ALTER TABLE `user_inbox_preference`
    ADD COLUMN `budget_warn_enabled` TINYINT NOT NULL DEFAULT 1 COMMENT '预算提醒（BUDGET_WARN）';
