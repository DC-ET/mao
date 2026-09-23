ALTER TABLE `agent`
    ADD COLUMN `enabled` TINYINT NOT NULL DEFAULT 1 COMMENT '1-启用 0-停用；停用后使用侧列表不展示，且不可新建会话' AFTER `is_default`;
