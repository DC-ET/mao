-- Add session:read permission for admin session management
INSERT INTO permission (name, code, description) VALUES ('查看会话', 'session:read', '查看会话');

-- Grant to ADMIN role (role_id = 1)
INSERT INTO role_permission (role_id, permission_id)
SELECT 1, id FROM permission WHERE code = 'session:read';
