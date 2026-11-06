-- V187: Agent 级 Git 凭据域（技术方案 2026-11-06「Agent 级 Git 凭据域收敛」）。
-- 作用：把「注入给会话的 git token 集合」从「该用户全部 token」收敛为「用户 token ∩ Agent 允许域」。
-- 三态语义：NULL=未配置（跟随全局策略 gitToken.scopePolicy）；'[]'=显式禁止注入；非空 JSON=白名单。
-- 与 skill_names / mcp_server_ids / http_tool_ids 的「空数组→存 NULL」惯例不同：
-- 本字段必须保留 '[]'，否则无法表达「显式禁止」，AgentService.updateAgent 对本字段单独处理。
ALTER TABLE `agent`
    ADD COLUMN `git_allowed_domains` VARCHAR(1024) NULL
    COMMENT '允许注入 Git 凭据的域名白名单（JSON 数组）：NULL=未配置（跟随全局策略），[]=禁止注入，非空=白名单'
    AFTER `http_tool_ids`;

-- 全局策略开关种子行：system_setting 缺行时管理后台分类卡片不渲染该控件，必须随迁移插入。
-- category 用已存在的分类名 'Agent 与模型'（挂在 TOC_GROUPS「模型任务」组下渲染）：
-- 「Agent 引擎」组下只有 integration 段落、没有该分类；写成组名会新建分类卡片并落入「其他」兜底。
INSERT IGNORE INTO `system_setting`
    (`setting_key`, `value`, `category`, `description`, `editable`, `is_secret`) VALUES
('gitToken.scopePolicy', 'lenient', 'Agent 与模型',
 'Git 凭据域策略：宽松=未配置允许域的 Agent 不限制；严格=不注入任何 Git 凭据', 1, 0);
