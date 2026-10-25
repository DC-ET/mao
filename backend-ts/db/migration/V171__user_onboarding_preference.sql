-- V171: 首启向导完成标记（首次成功体验）。
-- 一表一好（对齐 user_weixin_preference / user_task_panel_preference 模式）：
-- 无记录 = 从未走过向导（是否弹由 readiness 的 onboarding 状态结合会话历史判定）；
-- 有记录 = 完成（completed_at 非空）或跳过（skipped=1），均为完成语义，不再弹。
CREATE TABLE `user_onboarding_preference` (
  `user_id`         BIGINT PRIMARY KEY,
  `completed_at`    DATETIME NULL COMMENT '三步走完时间；跳过时为 NULL',
  `skipped`         TINYINT NOT NULL DEFAULT 0 COMMENT '1=中途跳过（完成语义，不再打扰）',
  `chosen_agent_id` BIGINT NULL COMMENT '向导第一步所选 Agent',
  `created_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='首启向导完成标记';
