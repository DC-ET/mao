-- 站内收件箱（任务收件箱 P1 + P2）：
-- notification 收件箱条目（TASK_COMPLETED/TASK_FAILED/QUESTION_PENDING/APPROVAL_PENDING/SUBAGENT_DONE）
-- + user_inbox_preference 按 kind 的偏好开关（含 P2 的 Electron 系统通知总开关）。
-- 跳转只认 session_id；执行要素（source/status/requestId 等）只放 payload_json。
-- dedup_key = "{userId}:{kind}:{sessionId}:{executionId|requestId}"，唯一键保证同一次事件只落一行。

CREATE TABLE IF NOT EXISTS `notification` (
    `id`          BIGINT       NOT NULL AUTO_INCREMENT,
    `user_id`     BIGINT       NOT NULL COMMENT '归属用户',
    `kind`        VARCHAR(48)  NOT NULL COMMENT 'TASK_COMPLETED/TASK_FAILED/QUESTION_PENDING/APPROVAL_PENDING/SUBAGENT_DONE',
    `title`       VARCHAR(256) NOT NULL COMMENT '标题，顶栏铃铛与列表共用',
    `content`     TEXT         NULL COMMENT '摘要正文，对外展示一行',
    `is_read`     TINYINT      NOT NULL DEFAULT 0 COMMENT '0=未读，1=已读（只影响铃铛徽标，与 session.unread 无关）',
    `read_at`     DATETIME     NULL COMMENT '已读时间',
    `session_id`  BIGINT       NULL COMMENT '跳转目标会话；会话被删后降级提示',
    `payload_json` JSON        NULL COMMENT '随事件附带的要素：source、status、requestId、错误原因等',
    `dedup_key`   VARCHAR(128) NOT NULL COMMENT 'userId:kind:sessionId:executionId|requestId',
    `created_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    UNIQUE KEY `uk_notification_dedup` (`dedup_key`),
    KEY `idx_notification_user_created` (`user_id`, `created_at`),
    KEY `idx_notification_user_read` (`user_id`, `is_read`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='站内收件箱条目';

CREATE TABLE IF NOT EXISTS `user_inbox_preference` (
    `user_id`                BIGINT  NOT NULL COMMENT '用户ID',
    `task_completed_enabled` TINYINT NOT NULL DEFAULT 1 COMMENT '任务完成',
    `question_pending_enabled` TINYINT NOT NULL DEFAULT 1 COMMENT '提问待答',
    `approval_pending_enabled` TINYINT NOT NULL DEFAULT 1 COMMENT '审批待办',
    `subagent_done_enabled`  TINYINT NOT NULL DEFAULT 0 COMMENT '子代理完成（默认关，防并行子代理刷屏）',
    `system_notify_enabled`  TINYINT NOT NULL DEFAULT 1 COMMENT 'Electron 系统通知总开关（仅桌面端生效，窗口未聚焦时弹出）',
    `created_at`             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户收件箱偏好';
