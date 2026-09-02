-- V095: 运行参数后台化 —— Agent 线程池 / WS 空闲超时 / 任务通知调度参数从 yml+环境变量迁入 system_setting。
-- value 初始为 NULL 表示"从未设置"（启动时由 SettingsBootstrap 用环境变量填充）；此后一律以 DB 为准。
-- 代码默认值：threadPoolSize=20 / threadPoolMax=100 / threadPoolQueue=200 / idleTimeoutMs=90000 /
--   workerDelayMs=30000 / batchSize=100 / maxAttempts=4。
-- 生效时机：任务通知 3 项保存后即时生效；Agent 线程池与 WS 空闲超时在启动时构建，修改后需重启后端。
-- MAX_CONCURRENT_AGENTS / DEFAULT_MAX_ROUNDS / DEFAULT_CONTEXT_ROUNDS 在 TS 后端无消费点（死配置），不迁移、直接废弃。

INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('agent.threadPoolSize', NULL, '运行参数', 'Agent 线程池核心数（重启后端后生效，默认 20）', 1),
('agent.threadPoolMax', NULL, '运行参数', 'Agent 线程池最大数（重启后端后生效，默认 100）', 1),
('agent.threadPoolQueue', NULL, '运行参数', 'Agent 线程池队列容量（重启后端后生效，默认 200）', 1),
('ws.idleTimeoutMs', NULL, '运行参数', 'WebSocket 空闲连接超时毫秒（重启后端后生效，默认 90000）', 1),
('notify.workerDelayMs', NULL, '运行参数', '任务通知调度轮询间隔毫秒（保存后即时生效，最小 1000，默认 30000）', 1),
('notify.batchSize', NULL, '运行参数', '任务通知每轮批量拉取条数（保存后即时生效，默认 100）', 1),
('notify.maxAttempts', NULL, '运行参数', '任务通知最大重试次数（保存后即时生效，默认 4）', 1);
