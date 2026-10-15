-- 用户运行时模式覆盖（技术方案 §5.12）：NULL 跟随全局 MAO_CLOUD_RUNTIME，docker/host 为显式覆盖
ALTER TABLE `user` ADD COLUMN `runtime_mode` VARCHAR(16) NULL DEFAULT NULL COMMENT '运行时模式覆盖: docker/host/NULL跟随全局' AFTER `status`;
