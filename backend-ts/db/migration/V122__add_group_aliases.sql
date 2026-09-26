ALTER TABLE user_task_panel_preference
    ADD COLUMN group_aliases JSON NOT NULL COMMENT '分组 key → 自定义显示名映射' AFTER collapsed_groups;
