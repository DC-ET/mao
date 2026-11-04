-- V184: 哨兵列表卡一句「上次变化：旧 → 新」的数据源——watcher 行新增「上次变化的
-- 新旧值对」，变化触发成功时与 markChecked 同写；基线重置 / 重新启用时清空。
ALTER TABLE `signal_watcher`
  ADD COLUMN `last_change_old_snippet` VARCHAR(1024) NULL AFTER `last_value_snippet`,
  ADD COLUMN `last_change_new_snippet` VARCHAR(1024) NULL AFTER `last_change_old_snippet`;
