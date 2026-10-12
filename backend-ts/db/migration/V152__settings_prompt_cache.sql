-- V152: Anthropic 协议顶层自动缓存断点（cache_control）后台化
-- 顶层自动断点把断点固定在「最后一个可缓存块」并随对话增长自动前移，是多轮 agent loop 的目标形态；
-- 不认该字段的网关由适配器降级器在首个 400 后自动停止发送。
-- value 初始为 NULL 表示"从未设置"（消费方用代码默认值）；此后一律以 DB 为准。
-- 生效时机：启动时构建 AnthropicLlmAdapter，修改后需重启后端。
-- 代码默认值：autoCacheEnabled=true（默认启用）、cacheTtl=5m（官方默认，仅 '5m' / '1h' 合法，其他值回落 5m）。

INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('harness.llm.anthropicAutoCache', NULL, '运行参数', 'Anthropic 协议自动缓存断点开关（重启后端后生效，默认启用）', 1),
('harness.llm.anthropicCacheTtl', NULL, '运行参数', 'Anthropic 缓存断点 TTL，取值 5m 或 1h（重启后端后生效，默认 5m）', 1);
