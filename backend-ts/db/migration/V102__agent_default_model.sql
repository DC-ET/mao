-- Agent 支持配置默认模型：会话未显式指定模型时，优先使用所属 Agent 的默认模型，其次全局默认模型
ALTER TABLE `agent`
  ADD COLUMN `default_model_id` BIGINT NULL COMMENT 'Agent 默认模型 ID（llm_model.id），NULL=未配置，运行时回退全局默认模型' AFTER `mcp_server_ids`;
