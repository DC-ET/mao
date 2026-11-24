-- 角色按 Agent 追加系统技能。agent_id = 0 表示该角色使用任何 Agent 都追加。
-- 技能名用 bin 排序：目录在 Linux 上区分大小写，默认 ci 会把 Foo / foo 收成一行。
CREATE TABLE IF NOT EXISTS `role_skill_grant` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `role_id`     BIGINT NOT NULL,
    `skill_name`  VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    `agent_id`    BIGINT NOT NULL DEFAULT 0 COMMENT '0 = 全部 Agent；否则只在该 Agent 追加',
    `created_at`  DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_role_skill_agent` (`role_id`, `skill_name`, `agent_id`),
    KEY `idx_role_skill_grant_agent` (`agent_id`),
    KEY `idx_role_skill_grant_skill` (`skill_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
