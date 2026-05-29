-- V015: Widen session_activity.target to accommodate long bash commands

ALTER TABLE `session_activity`
  MODIFY COLUMN `target` VARCHAR(2048) NULL COMMENT '文件路径/命令摘要';
