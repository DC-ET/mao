-- V138: 用量成本核算——模型价格列 + llm_call 成本快照 + AGENT 维度预算索引（技术方案 §5.1）。
-- 价格单位 = 管理员填写的统一成本口径（每百万 token）；NULL = 不计成本。
-- 历史数据不回填（写时快照原则，决策 1）：cost_micros 对旧行保持 NULL。
ALTER TABLE `llm_model`
    ADD COLUMN `price_input`  DECIMAL(12,6) NULL COMMENT '每百万输入 token 价格（成本单位；NULL=不计成本）',
    ADD COLUMN `price_output` DECIMAL(12,6) NULL COMMENT '每百万输出 token 价格（成本单位；NULL=不计成本）';

ALTER TABLE `llm_call`
    ADD COLUMN `cost_micros` BIGINT NULL COMMENT '本次调用成本快照 = 价格×tokens（成本单位×1e6 整数）；价格未配置时为 NULL',
    ADD INDEX `idx_llm_call_agent_created` (`agent_id`, `created_at`);
