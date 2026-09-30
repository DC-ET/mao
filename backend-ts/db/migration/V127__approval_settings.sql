-- V127: 审批设置：审批模型 + Jev 前置决策（TypeSafe System One / OpenRouter Decisions）

INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`, `is_secret`) VALUES
('approval.modelId', '', '审批', 'LOCAL 模式工具审批（智能预审/替我审批）使用的 LLM 模型；留空则使用会话模型', 1, 0),
('approval.jev.endpoint', 'https://api.typesafe.ai/v1/systemone', '审批', 'Jev 前置决策端点；OpenRouter 通道填 https://openrouter.ai/api/alpha/decisions', 1, 0),
('approval.jev.model', 'jev-latest', '审批', 'Jev 前置决策模型名；OpenRouter 通道填 typesafe/jev-1.13', 1, 0),
('approval.jev.apiKey', '', '审批', 'Jev 前置决策 API Key（工具名与参数会发往该第三方服务）；留空则关闭前置决策，直接由审批模型推理', 1, 1);
