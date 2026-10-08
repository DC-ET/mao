-- V135: LOCAL 工具审批放行规则（本会话总是允许 + 用户级持久 allowlist）
-- 规则类型：SHELL_PREFIX（前两 token 词边界前缀）/ SHELL_EXACT（归一化全命令全等）/ MCP_TOOL（工具全名全等）
-- 无唯一键：同值重复创建允许（alwaysAllow 落规则走应用层按 (session_id, rule_type, rule_value) 查重幂等）
CREATE TABLE IF NOT EXISTS `approval_rule` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`     BIGINT      NOT NULL COMMENT '创建者（匹配时按执行用户过滤）',
    `scope`       VARCHAR(16) NOT NULL COMMENT 'SESSION/USER',
    `session_id`  BIGINT      NULL COMMENT 'SESSION 规则的所属会话',
    `rule_type`   VARCHAR(16) NOT NULL COMMENT 'SHELL_PREFIX/SHELL_EXACT/MCP_TOOL',
    `rule_value`  VARCHAR(512) NOT NULL COMMENT '模式值（归一化后）',
    `hit_count`   BIGINT      NOT NULL DEFAULT 0,
    `last_hit_at` DATETIME    NULL,
    `enabled`     TINYINT     NOT NULL DEFAULT 1,
    `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY `idx_rule_user` (`user_id`, `enabled`),
    KEY `idx_rule_session` (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='LOCAL 工具审批放行规则';

-- denylist 扩展 token（admin 系统设置页「审批」分组可编辑；逗号分隔，与内置种子合并生效）
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`, `is_secret`) VALUES
('approval.rule.denyTokens', '', '审批', '审批规则 denylist 扩展 token（逗号分隔）：命令含任一 token（内置或扩展）时禁止创建/命中放行规则', 1, 0);

-- admin 只读清单权限码（默认只授系统管理员 role_id=1，对齐 V121 目录模式）
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '查看审批规则', 'approval-rule:read', '查看全用户 LOCAL 审批放行规则清单（只读）'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'approval-rule:read');

INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT 1, id FROM `permission` WHERE `code` = 'approval-rule:read';
