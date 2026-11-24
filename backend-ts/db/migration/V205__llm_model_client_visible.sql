-- 模型「客户端可选」开关（技术方案 docs/plan/2026-11/2026-11-24-llm-model-client-visible-technical-design.md §5）。
-- 与 status（启用）分开：只想「不在客户端暴露」时不必停用整个模型，
-- Agent 默认模型、机器人/渠道配置、系统参数与已绑定会话不受影响。
-- 默认 1：存量模型全部保持客户端可见，升级无感。与 agent.client_visible（V164）同义。
ALTER TABLE `llm_model`
    ADD COLUMN `client_visible` TINYINT NOT NULL DEFAULT 1
        COMMENT '1-客户端新建会话可选 0-仅管理端可配置（Agent 默认模型/渠道仍可用）' AFTER `status`;
