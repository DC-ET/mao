-- V215: Agent 静默问题上报（技术方案 2026-11-27 agent-issue-report）：report_issue 工具落库 + admin 处置。
--
-- 表：agent_report 存上报本体。detail 不复制对话原文，只存 session_id 引用，
-- 管理端点击跳转会话审计视图核对上下文。session/user/agent 三列由服务端从工具执行
-- 上下文注入（不在工具入参里，防模型伪造归因）；不做外键——会话/用户/Agent 删除后
-- 上报保留（运维信号独立性），查询时 LEFT JOIN 取名字。
-- 去重依赖应用层查询（同 session_id + category + title），不加唯一索引（title 自由文本）。
CREATE TABLE IF NOT EXISTS `agent_report` (
    `id`             BIGINT PRIMARY KEY AUTO_INCREMENT,
    `session_id`     BIGINT NULL COMMENT '上报来源会话（工具运行时注入）',
    `user_id`        BIGINT NULL COMMENT '会话归属用户',
    `agent_id`       BIGINT NULL COMMENT '会话归属 Agent',
    `category`       VARCHAR(32) NOT NULL COMMENT 'system_vulnerability / self_bug / tool_defect / skill_defect / malicious_instruction / other',
    `severity`       VARCHAR(16) NOT NULL DEFAULT 'medium' COMMENT 'low / medium / high / critical（模型自评建议值）',
    `title`          VARCHAR(255) NOT NULL COMMENT '问题标题（服务端截断 200 字符）',
    `detail`         TEXT NULL COMMENT '现象、复现路径、证据（服务端截断 8000 字符）',
    `status`         VARCHAR(16) NOT NULL DEFAULT 'OPEN' COMMENT 'OPEN / ACKNOWLEDGED / RESOLVED / DISMISSED',
    `resolution_note` TEXT NULL COMMENT '处置备注（RESOLVED / DISMISSED 时记录）',
    `resolved_by`    BIGINT NULL COMMENT '处置人（RESOLVED / DISMISSED 时记录）',
    `resolved_at`    DATETIME NULL COMMENT '处置时刻',
    `created_at`     DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`     DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_status_created` (`status`, `created_at`),
    INDEX `idx_session` (`session_id`),
    INDEX `idx_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 权限种子（仿 V149 范本），默认只授系统管理员角色（role_id = 1）。
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '查看 Agent 上报', 'agent-report:read', '查看 Agent 静默上报的问题列表与详情'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'agent-report:read');

INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '处置 Agent 上报', 'agent-report:write', '确认 / 解决 / 忽略 Agent 上报'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'agent-report:write');

INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT 1, id FROM `permission` WHERE `code` = 'agent-report:read';

INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT 1, id FROM `permission` WHERE `code` = 'agent-report:write';

-- 按 Agent 上报开关（§3.3）：默认开启，与全局开关 AND。
ALTER TABLE `agent`
    ADD COLUMN `report_issue_enabled` TINYINT(1) NOT NULL DEFAULT 1
    COMMENT 'report_issue 上报开关：1 开 0 关（与全局开关 agentReport.enabled AND）'
    AFTER `audio_model_id`;

-- 全局开关设置项（§3.3，仿 V149 种 feedback.draftModelId 先例）：默认开。
-- admin 设置页按 system_setting 行数据驱动渲染（editable=1 才出开关），不落行则设置页无 UI、
-- 搜索目录无落点，故迁移种行；后端读取侧仍以「缺键 = 开」兜底（agentReportEnabled()），删行不致命。
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('agentReport.enabled', 'true', 'Agent 与模型', 'Agent 问题上报（report_issue）全局开关：关闭后所有会话不再提供该工具，历史上报仍可查看与处置', 1);
