-- 任务执行结果消息「点踩反馈」：记录表 + 权限点。
-- 每条消息最多 1 条点踩记录（uk_message 唯一键），可覆盖更新原因、可取消。

CREATE TABLE IF NOT EXISTS `message_feedback` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `message_id`  BIGINT NOT NULL COMMENT '被点踩的 assistant 消息 ID',
    `session_id`  BIGINT NOT NULL COMMENT '冗余会话 ID，便于统计',
    `user_id`     BIGINT NOT NULL COMMENT '点踩用户（消息所属会话的用户）',
    `agent_id`    BIGINT COMMENT '冗余会话使用的 Agent，便于统计，可为空',
    `reason`      VARCHAR(32) NOT NULL COMMENT 'WRONG_RESULT / SLOW_RESPONSE / NOT_SOLVED / OTHER',
    `created_at`  DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_message` (`message_id`),
    INDEX `idx_created` (`created_at`),
    INDEX `idx_reason` (`reason`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '查看点踩反馈', 'feedback:read', '查看任务执行结果点踩反馈的汇总统计与明细记录'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'feedback:read');

INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT 1, id FROM `permission`
WHERE `code` = 'feedback:read';
