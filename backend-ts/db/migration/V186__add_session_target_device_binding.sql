-- V186: LOCAL 会话创建时绑定执行端设备（同表存设备名快照，供离线展示）。
-- 空值 = 未绑定（历史会话 / 旧客户端）：首次执行时按「发起连接设备 → 唯一在线同平台设备」
-- 惰性认领（技术方案 2026-11-05 D15），认领不了才回退用户级广播。
-- 创建后不可改绑：没有任何业务路径 UPDATE 这两个字段（认领仅补 NULL 行）。
ALTER TABLE `session`
  ADD COLUMN `target_device_id` VARCHAR(64) NULL COMMENT 'LOCAL 会话的执行端设备 id（创建时绑定，空=未绑定）' AFTER `execution_mode`,
  ADD COLUMN `target_device_name` VARCHAR(128) NULL COMMENT '执行端设备名快照（hostname，创建或认领时写入）' AFTER `target_device_id`;

-- 存量行保持 NULL，不做批量回填（无判据；由首次执行的惰性认领补登记）。
-- 逆运算（如需回滚）：
--   ALTER TABLE `session` DROP COLUMN `target_device_name`, DROP COLUMN `target_device_id`;
