-- 用户级 MCP 服务器启用偏好：用户在客户端设置页可单独停用/启用 MCP 服务器（仅影响本人会话）
-- 无记录 = 未单独配置，跟随管理后台全局启用状态
CREATE TABLE IF NOT EXISTS user_mcp_preference (
    id         BIGINT   NOT NULL AUTO_INCREMENT COMMENT '主键',
    user_id    BIGINT   NOT NULL COMMENT '用户ID',
    server_id  BIGINT   NOT NULL COMMENT 'MCP 服务器ID（mcp_server.id）',
    enabled    TINYINT  NOT NULL DEFAULT 1 COMMENT '用户级启用状态：0=停用 1=启用',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (id),
    UNIQUE KEY uk_user_server (user_id, server_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户级 MCP 服务器启用偏好';
