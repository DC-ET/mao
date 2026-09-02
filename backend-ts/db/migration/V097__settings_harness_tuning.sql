-- V097: harness 调参后台化 —— 上下文压缩 / LLM 超时重试 / 网页抓取 / Shell 会话 / 子代理超时
-- 从 application.yml 迁入 system_setting（category=运行参数）。
-- value 初始为 NULL 表示"从未设置"（消费方用代码默认值）；此后一律以 DB 为准。
-- 生效时机：均为启动时构建，修改后需重启后端。
-- delegate 两项本次同时接线到 SubagentExecutionRecoveryService（此前 yml 的 delegate 块无消费点，为死配置）。
-- 代码默认值：compaction(enabled=true, contextWindowTokens=256000, triggerRatio=0.8, maxSummaryTokens=12000,
--   loopMidwayCompact=true) / llm(rateLimitMaxRetries=10, rateLimitRetryDelaySeconds=2,
--   rateLimitMaxRetryDelaySeconds=30, callTimeoutSeconds=120, httpCallTimeoutSeconds=180,
--   streamIdleTimeoutSeconds=300) / webPage(connectTimeout=10000, readTimeout=30000, maxRawBytes=1048576,
--   maxOutputLength=500000, userAgent='Mozilla/5.0 (compatible; AgentWorkbench/1.0)') /
--   shell(maxSessionsPerConversation=30, sessionIdleTimeoutMinutes=30, sessionMaxLifetimeHours=2) /
--   delegate(timeoutSeconds=3600, cancelGraceSeconds=30)。

INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('harness.compaction.enabled', NULL, '运行参数', '上下文压缩开关（重启后端后生效，默认 true）', 1),
('harness.compaction.contextWindowTokens', NULL, '运行参数', '上下文窗口 token 数（重启后端后生效，默认 256000）', 1),
('harness.compaction.triggerRatio', NULL, '运行参数', '压缩触发比例，0~1 之间（重启后端后生效，默认 0.8）', 1),
('harness.compaction.maxSummaryTokens', NULL, '运行参数', '压缩摘要最大 token 数（重启后端后生效，默认 12000）', 1),
('harness.compaction.loopMidwayCompact', NULL, '运行参数', '循环中途压缩开关（重启后端后生效，默认 true）', 1),
('harness.llm.rateLimitMaxRetries', NULL, '运行参数', 'LLM 限流最大重试次数（重启后端后生效，默认 10）', 1),
('harness.llm.rateLimitRetryDelaySeconds', NULL, '运行参数', 'LLM 限流重试基础间隔秒（重启后端后生效，默认 2）', 1),
('harness.llm.rateLimitMaxRetryDelaySeconds', NULL, '运行参数', 'LLM 限流重试最大间隔秒（重启后端后生效，默认 30）', 1),
('harness.llm.callTimeoutSeconds', NULL, '运行参数', 'LLM 单次调用超时秒（重启后端后生效，默认 120）', 1),
('harness.llm.httpCallTimeoutSeconds', NULL, '运行参数', 'LLM HTTP 请求超时秒（重启后端后生效，默认 180）', 1),
('harness.llm.streamIdleTimeoutSeconds', NULL, '运行参数', 'LLM 流式空闲超时秒（重启后端后生效，默认 300）', 1),
('harness.webPage.connectTimeout', NULL, '运行参数', '网页抓取连接超时毫秒（重启后端后生效，默认 10000）', 1),
('harness.webPage.readTimeout', NULL, '运行参数', '网页抓取读取超时毫秒（重启后端后生效，默认 30000）', 1),
('harness.webPage.maxRawBytes', NULL, '运行参数', '网页抓取原始内容上限字节（重启后端后生效，默认 1048576）', 1),
('harness.webPage.maxOutputLength', NULL, '运行参数', '网页抓取输出字符上限（重启后端后生效，默认 500000）', 1),
('harness.webPage.userAgent', NULL, '运行参数', '网页抓取 User-Agent（重启后端后生效，默认 Mozilla/5.0 (compatible; AgentWorkbench/1.0)）', 1),
('harness.shell.maxSessionsPerConversation', NULL, '运行参数', '每会话最大 Shell 会话数（重启后端后生效，默认 30）', 1),
('harness.shell.sessionIdleTimeoutMinutes', NULL, '运行参数', 'Shell 会话空闲超时分钟（重启后端后生效，默认 30）', 1),
('harness.shell.sessionMaxLifetimeHours', NULL, '运行参数', 'Shell 会话最长存活小时（重启后端后生效，默认 2）', 1),
('harness.delegate.timeoutSeconds', NULL, '运行参数', '子代理执行超时秒（重启后端后生效，默认 3600）', 1),
('harness.delegate.cancelGraceSeconds', NULL, '运行参数', '子代理取消宽限秒（重启后端后生效，默认 30）', 1);
