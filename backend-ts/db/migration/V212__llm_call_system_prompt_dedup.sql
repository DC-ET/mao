-- V212: llm_call.system_prompt 内容寻址去重。
-- 新写入只存 sha，正文进 llm_call_system_prompt（相同原文一行）。
-- 存量行不回填：system_prompt_sha 为 NULL 时，详情仍读 llm_call.system_prompt。
-- 不删原列，启动迁移不扫大字段。无外键：正文先 INSERT IGNORE，调用行再记哈希。
CREATE TABLE `llm_call_system_prompt` (
    `sha` CHAR(64) NOT NULL COMMENT '正文 UTF-8 的 SHA-256 hex。主键去重，相同原文只存一行',
    `body` MEDIUMTEXT NOT NULL COMMENT '系统提示词原文（含截断标记）',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`sha`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='llm_call 系统提示词去重正文';

ALTER TABLE `llm_call`
    ADD COLUMN `system_prompt_sha` CHAR(64) NULL
        COMMENT '指向 llm_call_system_prompt.sha。NULL = 未走去重（历史行读 system_prompt / 无 system 消息）' AFTER `system_prompt`;
