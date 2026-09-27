-- 任务面板偏好：加乐观锁版本号。
-- save 是「读-改-整行写」，多端/多标签并发保存时会用旧快照覆盖前一次已成功的写入。
-- 更新时带上客户端读到的 version，冲突则失败，由上层重取合并后再写。
ALTER TABLE user_task_panel_preference
    ADD COLUMN version INT NOT NULL DEFAULT 0 COMMENT '乐观锁版本号，每次保存 +1' AFTER group_aliases;
