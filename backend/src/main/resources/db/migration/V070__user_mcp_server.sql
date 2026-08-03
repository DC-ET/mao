-- 用户级 MCP 服务器：mcp_server 表增加归属用户列，0=全局服务器（现有数据全为全局）
ALTER TABLE mcp_server
    ADD COLUMN user_id BIGINT NOT NULL DEFAULT 0 COMMENT '归属用户ID，0=全局服务器（管理员维护），>0=该用户私有服务器' AFTER id;

-- 唯一索引改为按用户维度：同一用户内名称唯一；user_id=0 时全局服务器之间仍唯一
-- 私有服务器与全局服务器重名（(N,name) 与 (0,name)）无法由索引约束，由服务层校验
ALTER TABLE mcp_server DROP INDEX uk_mcp_server_name;
ALTER TABLE mcp_server ADD UNIQUE KEY uk_mcp_user_name (user_id, name);

-- 移除 mcp:read / mcp:write 权限维度（需求：完全移除该权限，所有登录用户均可使用 MCP）
DELETE FROM role_permission
WHERE permission_id IN (SELECT id FROM permission WHERE code IN ('mcp:read', 'mcp:write'));
DELETE FROM permission WHERE code IN ('mcp:read', 'mcp:write');
