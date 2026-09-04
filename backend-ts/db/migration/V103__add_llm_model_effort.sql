-- 模型新增 reasoning effort 配置字段。
-- 留空表示使用协议默认值（openai-responses / openai-compatible 默认 high）。
-- 仅 openai-responses / openai-compatible（空 api_protocol）协议生效，anthropic 协议忽略。

ALTER TABLE `llm_model` ADD COLUMN `effort` VARCHAR(10) NOT NULL DEFAULT '' COMMENT 'reasoning effort: none/low/medium/high/xhigh/max，留空=协议默认' AFTER `api_protocol`;
