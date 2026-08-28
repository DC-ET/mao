-- 模型新增 API 协议字段：provider 恢复为渠道名（仅展示/分组），协议路由由 api_protocol 承载。
-- 空字符串表示 OpenAI 兼容协议（存量模型默认），可选值：openai-compatible / anthropic / openai-responses。

ALTER TABLE `llm_model` ADD COLUMN `api_protocol` VARCHAR(20) NOT NULL DEFAULT '' COMMENT 'API 协议：空=openai-compatible，anthropic，openai-responses' AFTER `provider`;
