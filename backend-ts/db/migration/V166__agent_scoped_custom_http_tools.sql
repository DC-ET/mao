-- 纠偏：自定义 HTTP 工具从「用户属主」改为「管理员配置 + 按 Agent 关联」（0.0.327）。
-- 初版原则：不考虑存量兼容，DROP 重建。
-- 执行口径不变：http_call 进 SERVER_ONLY_TOOLS 后端直连、无审批门；
-- SSRF 默认拒私网，管理员经 tools.http.privateAllowlist 显式放行内网段（环回与云元数据永拒）。
DROP TABLE IF EXISTS `user_tool_param`;
DROP TABLE IF EXISTS `user_tool`;

CREATE TABLE IF NOT EXISTS `http_tool` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `name`          VARCHAR(64) NOT NULL COMMENT 'slug：^[a-z][a-z0-9_]{0,63}$；避开内置工具名与 mcp__ 命名空间；全局唯一',
    `display_name`  VARCHAR(128) NOT NULL COMMENT '中文展示名',
    `description`   VARCHAR(1000) NOT NULL COMMENT '给模型的用途说明（目录分节展示）',
    `method`        VARCHAR(8) NOT NULL DEFAULT 'GET' COMMENT 'GET/HEAD/POST/PUT/PATCH/DELETE',
    `url`           VARCHAR(1024) NOT NULL COMMENT '端点 URL（http/https）',
    `headers_json`  TEXT NULL COMMENT '固定请求头；敏感值 AES-GCM 加密存储，脱敏回显',
    `body_template` TEXT NULL COMMENT '请求体模板，{{参数名}} 占位（纯文本替换，不递归）',
    `read_only`     TINYINT NOT NULL DEFAULT 0 COMMENT '只读声明：目录分节标记与 describe 回显的统一依据（无审批门）；新建时按方法预推断',
    `timeout_ms`    INT NOT NULL DEFAULT 15000 COMMENT '钳制 1000..60000',
    `enabled`       TINYINT NOT NULL DEFAULT 1 COMMENT '管理员全局启停；停用即从所有 Agent 的目录与可调用集合移除',
    `created_at`    DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_http_tool_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='自定义 HTTP 工具定义（管理员配置）';

CREATE TABLE IF NOT EXISTS `http_tool_param` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `tool_id`       BIGINT NOT NULL,
    `name`          VARCHAR(64) NOT NULL COMMENT '参数名 slug（http_call arguments 的键）',
    `label`         VARCHAR(128) NOT NULL COMMENT '参数中文说明',
    `type`          VARCHAR(16) NOT NULL DEFAULT 'string' COMMENT 'string/number/boolean',
    `required`      TINYINT NOT NULL DEFAULT 0,
    `default_value` VARCHAR(500) NULL,
    `sort_order`    INT NOT NULL DEFAULT 0,
    INDEX `idx_http_tool_param_tool` (`tool_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='自定义工具参数定义';

-- Agent 关联：镜像 mcp_server_ids（V067）范式，JSON 数组，为空表示不关联
ALTER TABLE `agent` ADD COLUMN `http_tool_ids` VARCHAR(1024) NULL
    COMMENT '关联的自定义 HTTP 工具 ID 列表（JSON 数组），为空表示不启用' AFTER `mcp_server_ids`;

-- 移除单用户启用上限设置（归属模型变更后失去意义；privateAllowlist 保留不动）
DELETE FROM `system_setting` WHERE `setting_key` = 'tools.http.maxEnabledPerUser';

-- 权限：user_tool:read 改码 http_tool:read，新增 http_tool:write（对齐 V067 mcp:write 范式）
UPDATE `permission` SET `code` = 'http_tool:read', `name` = '查看自定义工具',
    `description` = '查看自定义 HTTP 工具清单与调用统计' WHERE `code` = 'user_tool:read';
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '管理自定义工具', 'http_tool:write', '新建、编辑、删除、启停自定义 HTTP 工具并试运行'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'http_tool:write');
INSERT INTO `role_permission` (`role_id`, `permission_id`)
SELECT 1, id FROM `permission` WHERE `code` IN ('http_tool:read', 'http_tool:write')
  AND NOT EXISTS (SELECT 1 FROM `role_permission` WHERE `role_id` = 1 AND `permission_id` = permission.id);
