-- 供应商允许的请求体上限（字节）。用于推导会话压缩的体积触发阈值（上限 × 0.8）；
-- NULL 表示未声明，回退全局阈值 harness.compaction.triggerPayloadBytes。
ALTER TABLE `llm_model`
  ADD COLUMN `max_request_body_bytes` BIGINT NULL DEFAULT NULL
  COMMENT '供应商请求体上限（字节），NULL=未知' AFTER `context_window_tokens`;

-- 请求体体积触发阈值（字节）：补充 system_setting 初始化行，否则管理后台整组保存会报
-- 「系统配置不存在: harness.compaction.triggerPayloadBytes」。NULL = 用代码默认值 40MiB，0 = 关闭体积触发。
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('harness.compaction.triggerPayloadBytes', NULL, '运行参数', '请求体体积触发阈值字节数，0=关闭（重启后端后生效，默认 41943040，即 40MiB）', 1);
