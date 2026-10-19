-- V160: 全局用户运行时模式支持管理后台切换（容器隔离技术方案 §5.12）。
-- 消费方 RuntimeModeResolver：本行优先，缺行 / 值非法 / 查询失败回落 MAO_CLOUD_RUNTIME（默认 host）。
-- 用户级覆盖仍在 user.runtime_mode（管理后台「用户管理 → 编辑用户 → 运行时模式」）。
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`, `is_secret`) VALUES
('runtime.mode', 'host', '运行环境', '用户运行时模式（全局）：host=宿主机 | docker=每用户容器隔离。保存后无需重启，5 秒内生效；MAO_CLOUD_RUNTIME 仅作为缺省值', 1, 0);
