-- MCP（Model Context Protocol）服务器配置表
CREATE TABLE mcp_server (
    id          BIGINT       NOT NULL AUTO_INCREMENT COMMENT '主键',
    name        VARCHAR(64)  NOT NULL COMMENT '服务器唯一标识（小写字母/数字/下划线/中划线），工具名前缀来源',
    description VARCHAR(512) NULL     COMMENT '描述',
    server_type VARCHAR(16)  NOT NULL COMMENT 'STDIO | HTTP',
    command     VARCHAR(256) NULL     COMMENT 'STDIO 启动命令，如 npx',
    args_json   TEXT         NULL     COMMENT 'STDIO 启动参数 JSON 数组，如 ["-y","@modelcontextprotocol/server-filesystem","/tmp"]',
    url         VARCHAR(512) NULL     COMMENT 'HTTP/SSE 服务器 URL',
    env_json    TEXT         NULL     COMMENT '环境变量 JSON（含密钥字段整体 AES/GCM 加密存储）',
    status      VARCHAR(16)  NOT NULL DEFAULT 'ENABLED' COMMENT 'ENABLED | DISABLED',
    created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    deleted     TINYINT      NOT NULL DEFAULT 0 COMMENT '逻辑删除 0=正常 1=删除',
    PRIMARY KEY (id),
    UNIQUE KEY uk_mcp_server_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='MCP 服务器配置';

-- Agent 关联的 MCP 服务器 ID 列表（JSON 数组），为空表示不启用 MCP
ALTER TABLE agent
    ADD COLUMN mcp_server_ids VARCHAR(1024) NULL COMMENT '关联的 MCP 服务器 ID 列表（JSON 数组），为空表示不启用 MCP' AFTER skill_names;

-- MCP 服务器管理权限（仅授予系统管理员）
INSERT INTO permission (name, code, description) VALUES ('查看MCP服务器', 'mcp:read', '查看 MCP 服务器配置');
INSERT INTO permission (name, code, description) VALUES ('管理MCP服务器', 'mcp:write', '创建、编辑、删除 MCP 服务器配置');

INSERT INTO role_permission (role_id, permission_id)
SELECT 1, id FROM permission WHERE code IN ('mcp:read', 'mcp:write')
  AND NOT EXISTS (SELECT 1 FROM role_permission WHERE role_id = 1 AND permission_id = permission.id);
