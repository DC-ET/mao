-- V159: MCP 工作集（Working Set）模式（docs/plan/2026-10-18-mcp-working-set-design.md §5.1）。
--
-- 模式是「用户级单值偏好」，与 per-server 的 user_mcp_preference（user_id + server_id + enabled）
-- 粒度不同，必须独立建表：
--   1) UserMcpPreferenceService.save(enabled=true) 会删行，同行存 load_mode 会随之丢失；
--   2) 没有任何 server 偏好行的用户（全部启用）无行可存模式；
--   3) per-server 行上存单值会出现多行不一致，语义上无「以哪行为准」的定义。
-- 无记录 = 未单独配置，跟随全局 mcp.loadMode。

CREATE TABLE IF NOT EXISTS `user_mcp_load_mode` (
    `id`         BIGINT      NOT NULL AUTO_INCREMENT COMMENT '主键',
    `user_id`    BIGINT      NOT NULL COMMENT '用户ID',
    `load_mode`  VARCHAR(16) NOT NULL DEFAULT 'WORKING_SET' COMMENT 'MCP 工具加载模式：WORKING_SET=工作集（默认） | FULL=全量注入',
    `created_at` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
    `updated_at` DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_user_load_mode` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户级 MCP 工具加载模式偏好';

-- 全局默认：行缺失或值非法时消费方回落 working_set（resolveMcpLoadMode）。
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`, `is_secret`) VALUES
('mcp.loadMode', 'working_set', '运行参数', 'MCP 工具加载模式：working_set=工作集（默认） | full=全量注入', 1, 0);
