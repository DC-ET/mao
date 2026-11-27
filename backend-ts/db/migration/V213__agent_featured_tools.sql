-- V213: Agent 特色工具（技术方案 2026-11-27「Agent 特色工具配置」）。
-- 取值（JSON 数组）：image_generation / text_to_speech；NULL 或 '[]' = 未启用。
-- 与 skill_names / mcp_server_ids / http_tool_ids 同口径：空数组折叠为 NULL。
-- 存量 Agent 回填 image_generation，保持现网出图能力；TTS 为新增能力，默认关闭。
ALTER TABLE `agent`
    ADD COLUMN `featured_tools` VARCHAR(512) NULL
    COMMENT '特色工具（JSON 数组）：image_generation/text_to_speech；NULL/[]=未启用'
    AFTER `git_allowed_domains`;

UPDATE `agent` SET `featured_tools` = '["image_generation"]' WHERE `featured_tools` IS NULL;