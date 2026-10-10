-- API Token 明文加密留存：支持属主在创建后再次复制（docs/plan/2026-10-05-open-api-webhook-technical-design.md §5.1 的
-- 「明文不落库」约束就此放宽为「不明文落库」——密文落库，明文仅内存与响应中出现）。
-- 改动前签发的行 token_cipher 为 NULL，无法再取回明文（sha256 不可逆），需吊销重签；鉴权始终走 token_hash，不受本列影响。
-- 密钥同域独立配置 APP_OPENAPI_TOKEN_SECRET，未配置回退内置默认密钥；轮换密钥后旧密文无法解密（仅影响再次复制）。
ALTER TABLE `api_token`
    ADD COLUMN `token_cipher` TEXT NULL COMMENT 'AES-GCM 加密的明文 Token，供属主再次复制时解密；历史行为 NULL';
