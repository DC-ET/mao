-- V202: 浏览器直播回放（录制 + 回看，技术方案 docs/plan/2026-11/2026-11-22-browser-live-replay-technical-design.md §3.1/§3.6）。
-- recordEnabled 默认 '0' 显式关闭（录屏含登录态页面敏感信息，管理员手动开启）；
-- 两个 TTL 键 value 为 NULL（"从未设置"）：由 SettingsBootstrap 用环境变量一次性填充
-- （MAO_CLEANUP_BROWSER_REPLAY_DAYS / 存量 MAO_CLEANUP_SHELL_MAX_AGE_DAYS），
-- 未设置时消费方回落内置默认 7 天。这里若种值，bootstrap「仅 NULL 时导入」永不触发，存量 env 会失效。
-- 两个 TTL 保存后即时生效（清理调度器每轮现读，无需重启）。
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`, `is_secret`) VALUES
('browserLive.recordEnabled', '0', '运行环境', '浏览器直播录制开关：1=开启。录屏含登录态页面敏感信息，按保留天数自动清理；对新会话生效。', 1, 0),
('harness.cleanup.browserReplayTtlDays', NULL, '运行环境', '浏览器直播回放保留天数：0=关闭按天清理（回放仍随会话删除清理）；默认 7。保存后即时生效。', 1, 0),
('harness.cleanup.shellOutputMaxAgeDays', NULL, '运行环境', 'shell 输出与网页全文缓存保留天数：0=不清理；默认 7。保存后即时生效。', 1, 0);
