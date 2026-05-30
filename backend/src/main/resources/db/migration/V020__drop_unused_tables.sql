-- Drop unused tables that have no corresponding Java entity/mapper/service

-- Remove department_id from user table
ALTER TABLE `user` DROP COLUMN `department_id`;

DROP TABLE IF EXISTS `department`;
DROP TABLE IF EXISTS `system_config`;
DROP TABLE IF EXISTS `agent_permission`;
DROP TABLE IF EXISTS `notification`;
DROP TABLE IF EXISTS `shell_session`;
DROP TABLE IF EXISTS `shell_command_log`;
