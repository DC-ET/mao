-- 模型凭证方式双轨（技术方案 docs/plan/2026-11-19-llm-model-ecp-token-auth-technical-design.md §3.2）。
-- api_key=模型固定 API Key（存量默认，行为不变）；ecp=调用时使用当前用户的 ECP Token。
-- api_key 列保持 NOT NULL：ecp 模式写入空串占位，不作语义使用（运行时严格按 auth_type 分流，
-- 绝不回退到 api_key，避免「以为走个人票、实际烧共享 Key」的隐性错误）。
ALTER TABLE `llm_model`
    ADD COLUMN `auth_type` VARCHAR(16) NOT NULL DEFAULT 'api_key'
        COMMENT '凭证方式：api_key=模型固定 API Key；ecp=当前用户 ECP Token';
