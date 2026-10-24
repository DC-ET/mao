-- Agent 团队经验库开关（技术方案 2026-10-24）：1=工作区挂载 团队经验/ 链接并注入路标节；
-- 0=不挂载、不注入。默认 1：存量 Agent 开箱即用，升级无感。
ALTER TABLE `agent`
    ADD COLUMN `experience_library_enabled` TINYINT NOT NULL DEFAULT 1
    COMMENT '1-启用团队经验库 0-停用' AFTER `client_visible`;
