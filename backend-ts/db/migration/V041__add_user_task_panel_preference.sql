CREATE TABLE user_task_panel_preference (
    user_id          BIGINT   NOT NULL PRIMARY KEY COMMENT '用户 ID',
    group_order      JSON     NOT NULL COMMENT '任务分组 key 顺序',
    collapsed_groups JSON     NOT NULL COMMENT '收起的分组 key 列表',
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户任务面板 UI 偏好';
