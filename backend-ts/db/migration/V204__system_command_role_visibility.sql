ALTER TABLE `user_command`
    ADD COLUMN `visibility` VARCHAR(16) NOT NULL DEFAULT 'all' COMMENT 'all=全局 roles=指定角色；仅 user_id=0 使用 roles';

CREATE TABLE IF NOT EXISTS `user_command_role` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `command_id`  BIGINT NOT NULL,
    `role_id`     BIGINT NOT NULL,
    `created_at`  DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_command_role` (`command_id`, `role_id`),
    KEY `idx_user_command_role_role` (`role_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
