-- 客户端新建会话可选性：与 enabled（运行时停用）分开，避免隐藏动作影响已绑定会话。
-- 默认 1：存量 Agent 全部保持可见，升级无感。
ALTER TABLE `agent`
    ADD COLUMN `client_visible` TINYINT NOT NULL DEFAULT 1
    COMMENT '1-客户端新建会话可选 0-仅管理端可见' AFTER `enabled`;
