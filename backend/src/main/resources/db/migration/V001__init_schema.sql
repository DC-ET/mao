-- ========== 用户与权限 ==========

CREATE TABLE `user` (
    `id`              BIGINT PRIMARY KEY AUTO_INCREMENT,
    `username`        VARCHAR(64) NOT NULL UNIQUE,
    `display_name`    VARCHAR(128) NOT NULL,
    `email`           VARCHAR(128),
    `avatar_url`      VARCHAR(512),
    `auth_type`       VARCHAR(20) NOT NULL COMMENT 'LDAP / FEISHU',
    `password_hash`   VARCHAR(128) COMMENT 'LDAP 用户可为空',
    `feishu_user_id`  VARCHAR(64) COMMENT '飞书用户 ID',
    `department_id`   BIGINT,
    `status`          TINYINT DEFAULT 1 COMMENT '1-启用 0-禁用',
    `last_login_at`   DATETIME,
    `created_at`      DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `role` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `name`        VARCHAR(64) NOT NULL UNIQUE COMMENT '角色名称',
    `code`        VARCHAR(64) NOT NULL UNIQUE COMMENT '角色编码',
    `description` VARCHAR(256),
    `created_at`  DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `user_role` (
    `id`      BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `role_id` BIGINT NOT NULL,
    UNIQUE KEY `uk_user_role` (`user_id`, `role_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `permission` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `name`        VARCHAR(128) NOT NULL,
    `code`        VARCHAR(128) NOT NULL UNIQUE COMMENT '权限编码，如 agent:read, agent:write',
    `description` VARCHAR(256),
    `created_at`  DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `role_permission` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `role_id`       BIGINT NOT NULL,
    `permission_id` BIGINT NOT NULL,
    UNIQUE KEY `uk_role_perm` (`role_id`, `permission_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `department` (
    `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
    `name`       VARCHAR(128) NOT NULL,
    `parent_id`  BIGINT DEFAULT 0,
    `sort_order` INT DEFAULT 0,
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ========== AI 模型配置 ==========

CREATE TABLE `llm_model` (
    `id`              BIGINT PRIMARY KEY AUTO_INCREMENT,
    `name`            VARCHAR(128) NOT NULL COMMENT '模型显示名称',
    `provider`        VARCHAR(64) COMMENT '供应商标识',
    `base_url`        VARCHAR(512) NOT NULL COMMENT 'API 地址',
    `api_key`         VARCHAR(512) NOT NULL COMMENT '加密存储的 API Key',
    `model_id`        VARCHAR(128) NOT NULL COMMENT '模型标识，如 gpt-4o',
    `max_tokens`      INT DEFAULT 4096,
    `temperature_max` DECIMAL(3,2) DEFAULT 2.00,
    `status`          TINYINT DEFAULT 1 COMMENT '1-启用 0-禁用',
    `created_at`      DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ========== Agent ==========

CREATE TABLE `agent` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `name`          VARCHAR(128) NOT NULL,
    `description`   TEXT,
    `icon_url`      VARCHAR(512),
    `system_prompt` TEXT NOT NULL COMMENT '系统提示词（人格设定）',
    `model_id`      BIGINT NOT NULL COMMENT '关联的 LLM 模型',
    `creator_id`    BIGINT NOT NULL COMMENT '创建者用户 ID',
    `type`          VARCHAR(20) NOT NULL COMMENT 'SYSTEM-系统级 PERSONAL-个人',
    `visibility`    VARCHAR(20) DEFAULT 'PRIVATE' COMMENT 'PRIVATE / HUB / SPECIFIC',
    `status`        VARCHAR(20) DEFAULT 'DRAFT' COMMENT 'DRAFT/PUBLISHED/ARCHIVED',
    `token_limit`   INT DEFAULT 0 COMMENT '单次对话 Token 限额，0-不限',
    `max_rounds`    INT DEFAULT 0 COMMENT '单次对话最大轮数，0-不限',
    `config_json`   JSON COMMENT '扩展配置',
    `published_at`  DATETIME COMMENT '发布到 Hub 的时间',
    `created_at`    DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `agent_tag` (
    `id`       BIGINT PRIMARY KEY AUTO_INCREMENT,
    `agent_id` BIGINT NOT NULL,
    `tag`      VARCHAR(64) NOT NULL,
    INDEX `idx_agent_tag` (`agent_id`, `tag`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `agent_skill` (
    `id`       BIGINT PRIMARY KEY AUTO_INCREMENT,
    `agent_id` BIGINT NOT NULL,
    `skill_id` BIGINT NOT NULL COMMENT '关联 skill 表',
    `config`   JSON COMMENT '该 Agent 对此 Skill 的定制配置',
    UNIQUE KEY `uk_agent_skill` (`agent_id`, `skill_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `agent_mcp_config` (
    `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
    `agent_id`   BIGINT NOT NULL,
    `server_url` VARCHAR(512) NOT NULL COMMENT 'MCP Server 地址',
    `transport`  VARCHAR(20) DEFAULT 'SSE' COMMENT 'SSE / STDIO',
    `config`     JSON COMMENT '额外配置',
    `status`     TINYINT DEFAULT 1,
    INDEX `idx_agent` (`agent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `agent_permission` (
    `id`               BIGINT PRIMARY KEY AUTO_INCREMENT,
    `agent_id`         BIGINT NOT NULL,
    `permission_type`  VARCHAR(20) NOT NULL COMMENT 'ROLE / DEPARTMENT / USER',
    `permission_value` BIGINT NOT NULL COMMENT '对应 role_id / department_id / user_id',
    UNIQUE KEY `uk_agent_perm` (`agent_id`, `permission_type`, `permission_value`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ========== Skills ==========

CREATE TABLE `skill` (
    `id`           BIGINT PRIMARY KEY AUTO_INCREMENT,
    `name`         VARCHAR(128) NOT NULL,
    `description`  TEXT,
    `type`         VARCHAR(20) NOT NULL COMMENT 'BUILTIN-内置',
    `input_schema`  JSON COMMENT '输入参数 JSON Schema',
    `output_schema` JSON COMMENT '输出参数 JSON Schema',
    `impl_class`   VARCHAR(256) COMMENT '内置 Skill 的 Java 实现类全限定名',
    `creator_id`   BIGINT,
    `status`       VARCHAR(20) DEFAULT 'ACTIVE' COMMENT 'ACTIVE/DISABLED',
    `created_at`   DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ========== 会话与消息 ==========

CREATE TABLE `session` (
    `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`    BIGINT NOT NULL,
    `agent_id`   BIGINT NOT NULL,
    `title`      VARCHAR(256) COMMENT '会话标题，可自动生成',
    `status`     VARCHAR(20) DEFAULT 'ACTIVE' COMMENT 'ACTIVE/ARCHIVED',
    `is_pinned`  TINYINT DEFAULT 0,
    `is_favorite` TINYINT DEFAULT 0,
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_user` (`user_id`),
    INDEX `idx_agent` (`agent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `message` (
    `id`           BIGINT PRIMARY KEY AUTO_INCREMENT,
    `session_id`   BIGINT NOT NULL,
    `role`         VARCHAR(20) NOT NULL COMMENT 'USER / ASSISTANT / SYSTEM / TOOL',
    `content`      MEDIUMTEXT COMMENT '消息内容',
    `tool_call_id` VARCHAR(128) COMMENT '工具调用 ID（tool role 消息时使用）',
    `tool_calls`   JSON COMMENT '工具调用列表（assistant 消息中的 function_call）',
    `token_count`  INT DEFAULT 0 COMMENT '本条消息的 Token 消耗',
    `model_id`     BIGINT COMMENT '使用的模型',
    `metadata`     JSON COMMENT '扩展元数据',
    `created_at`   DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_session` (`session_id`),
    INDEX `idx_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ========== Hub ==========

CREATE TABLE `hub_installation` (
    `id`           BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`      BIGINT NOT NULL,
    `agent_id`     BIGINT NOT NULL COMMENT 'Hub 中的 Agent',
    `installed_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_user_agent` (`user_id`, `agent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ========== 审计日志 ==========

CREATE TABLE `audit_log` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`       BIGINT,
    `username`      VARCHAR(64),
    `action`        VARCHAR(64) NOT NULL COMMENT '操作类型',
    `resource_type` VARCHAR(64) COMMENT '资源类型',
    `resource_id`   VARCHAR(64) COMMENT '资源 ID',
    `detail`        JSON COMMENT '操作详情',
    `ip`            VARCHAR(45),
    `user_agent`    VARCHAR(512),
    `created_at`    DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_user` (`user_id`),
    INDEX `idx_action` (`action`),
    INDEX `idx_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `api_call_log` (
    `id`             BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`        BIGINT,
    `session_id`     BIGINT,
    `agent_id`       BIGINT,
    `endpoint`       VARCHAR(256) NOT NULL,
    `method`         VARCHAR(10),
    `request_body`   MEDIUMTEXT,
    `response_code`  INT,
    `latency_ms`     INT,
    `llm_model`      VARCHAR(128),
    `llm_tokens_in`  INT DEFAULT 0,
    `llm_tokens_out` INT DEFAULT 0,
    `created_at`     DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_session` (`session_id`),
    INDEX `idx_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ========== 初始数据 ==========

-- 默认角色
INSERT INTO `role` (`name`, `code`, `description`) VALUES
('系统管理员', 'ADMIN', '拥有所有权限'),
('普通用户', 'USER', '基本使用权限');

-- 默认权限
INSERT INTO `permission` (`name`, `code`, `description`) VALUES
('查看Agent', 'agent:read', '查看 Agent 列表和详情'),
('管理Agent', 'agent:write', '创建、编辑、删除 Agent'),
('查看用户', 'user:read', '查看用户列表'),
('管理用户', 'user:write', '创建、编辑、禁用用户'),
('查看模型', 'model:read', '查看模型配置'),
('管理模型', 'model:write', '创建、编辑、删除模型配置'),
('查看审计日志', 'audit:read', '查看审计日志'),
('管理Hub', 'hub:write', '审核和管理 Hub 中的 Agent');

-- 管理员拥有所有权限
INSERT INTO `role_permission` (`role_id`, `permission_id`)
SELECT 1, id FROM `permission`;

-- 普通用户只有查看权限
INSERT INTO `role_permission` (`role_id`, `permission_id`)
SELECT 2, id FROM `permission` WHERE `code` IN ('agent:read', 'model:read');

-- 默认管理员账号 (admin / admin123)
INSERT INTO `user` (`username`, `display_name`, `email`, `auth_type`, `password_hash`, `status`) VALUES
('admin', '管理员', 'admin@agentworkbench.com', 'LOCAL', '$2b$12$HDT85UDBpTv30P8kKrs1euencz94fhd1tw/W7zrOjyF8WrDQF1Z3G', 1);

INSERT INTO `user_role` (`user_id`, `role_id`) VALUES (1, 1);
