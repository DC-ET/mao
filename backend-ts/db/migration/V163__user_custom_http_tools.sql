-- 自定义 HTTP 工具（懒加载集成）：用户声明式 HTTP 工具定义 + 参数定义
-- （docs/plan/2026-10-19-custom-http-tools-technical-design.md §5.1）。
-- 执行口径（方案二）：http_call 进 SERVER_ONLY_TOOLS 后端直连、无审批门；
-- SSRF 默认拒私网，管理员经 tools.http.privateAllowlist 显式放行内网段（环回与云元数据永拒）。
CREATE TABLE IF NOT EXISTS `user_tool` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`       BIGINT NOT NULL COMMENT '属主',
    `name`          VARCHAR(64) NOT NULL COMMENT 'slug：^[a-z][a-z0-9_]{0,63}$；避开内置工具名与 mcp__ 命名空间',
    `display_name`  VARCHAR(128) NOT NULL COMMENT '中文展示名',
    `description`   VARCHAR(1000) NOT NULL COMMENT '给模型的用途说明（目录分节展示）',
    `method`        VARCHAR(8) NOT NULL DEFAULT 'GET' COMMENT 'GET/HEAD/POST/PUT/PATCH/DELETE',
    `url`           VARCHAR(1024) NOT NULL COMMENT '端点 URL（http/https）',
    `headers_json`  TEXT NULL COMMENT '固定请求头；敏感值 AES-GCM 加密存储，脱敏回显',
    `body_template` TEXT NULL COMMENT '请求体模板，{{参数名}} 占位（纯文本替换，不递归）',
    `read_only`     TINYINT NOT NULL DEFAULT 0 COMMENT '只读声明：目录分节标记与 describe 回显的统一依据（无审批门）；新建时按方法预推断',
    `timeout_ms`    INT NOT NULL DEFAULT 15000 COMMENT '钳制 1000..60000',
    `enabled`       TINYINT NOT NULL DEFAULT 1,
    `created_at`    DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_user_tool_name` (`user_id`, `name`),
    INDEX `idx_user_tool_user` (`user_id`, `enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户自定义 HTTP 工具定义';

CREATE TABLE IF NOT EXISTS `user_tool_param` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `tool_id`       BIGINT NOT NULL,
    `name`          VARCHAR(64) NOT NULL COMMENT '参数名 slug（http_call arguments 的键）',
    `label`         VARCHAR(128) NOT NULL COMMENT '参数中文说明',
    `type`          VARCHAR(16) NOT NULL DEFAULT 'string' COMMENT 'string/number/boolean',
    `required`      TINYINT NOT NULL DEFAULT 0,
    `default_value` VARCHAR(500) NULL,
    `sort_order`    INT NOT NULL DEFAULT 0,
    INDEX `idx_user_tool_param_tool` (`tool_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='自定义工具参数定义';

-- 内网网段放行清单（CIDR JSON 数组）：环回与云元数据端点永拒；默认空数组=一律按私网拒绝。
-- 单用户可启用的自定义工具数上限（超限时目录与可调用集合取前 N，name ASC）。
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`, `is_secret`) VALUES
('tools.http.privateAllowlist', '[]', '自定义 HTTP 工具', '自定义 HTTP 工具允许访问的内网网段（CIDR JSON 数组，如 ["10.0.0.0/8","192.168.1.0/24"]）。环回与云元数据端点永拒；默认空数组=一律按私网拒绝', 1, 0),
('tools.http.maxEnabledPerUser', '20', '自定义 HTTP 工具', '单用户可启用的自定义工具数上限（超出后按名称排序取前 N 个加载）', 1, 0);

-- 管理后台只读清单与调用统计权限（默认授系统管理员角色，对齐 V151 范式）
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '查看自定义工具', 'user_tool:read', '查看全站自定义工具清单与调用统计'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'user_tool:read');
INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT 1, id FROM `permission` WHERE `code` = 'user_tool:read';
