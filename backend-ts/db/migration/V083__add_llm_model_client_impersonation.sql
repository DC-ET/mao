-- 模型客户端标识配置化：llm_model 新增 client_impersonation 列。
-- 取值：'none'（不注入）/ 'codex'（Codex CLI 伪装头）/ 'claude_code'（Claude Code CLI 伪装头）。
-- 存量行由 DEFAULT 'none' 自动填充，即升级后存量模型不再按模型名自动注入伪装头，
-- 需要伪装头的模型由管理员在后台编辑改为对应档位。

ALTER TABLE `llm_model`
    ADD COLUMN `client_impersonation` VARCHAR(20) NOT NULL DEFAULT 'none'
        COMMENT '客户端标识：none=不注入，codex=Codex CLI 头，claude_code=Claude Code CLI 头';
