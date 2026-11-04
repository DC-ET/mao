-- V185: 信号哨兵轮询记录新增新旧值片段（上次值 / 本次值，与触发 prompt 的 {diff} 同口径）。
-- 原拟 V183，与群聊运行身份 V183__session_last_runtime_user.sql 撞号；重复版本会被跳过，故改号。
-- 存 truncate(text, 500)；列宽 1024 与 last_value_snippet 对齐，防多字节截断写爆。
ALTER TABLE `signal_watcher_check`
  ADD COLUMN `old_value_snippet` VARCHAR(1024) NULL AFTER `value_hash`,
  ADD COLUMN `new_value_snippet` VARCHAR(1024) NULL AFTER `old_value_snippet`;
