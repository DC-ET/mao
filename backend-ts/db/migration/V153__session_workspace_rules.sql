-- V153: 会话级工作区规则快照（提示词前缀缓存稳定化）
-- 同一会话内「工作区规则」节（AGENTS.md 前 200 行）文本冻结：会话内编辑 AGENTS.md
-- 不再打掉 system 前缀，只对新会话 / 压缩提交后 / 会话删除后生效。
-- 落库而非进程内存：蓝绿重启后沿用同一文本，避免部署窗口制造一次全站前缀塌陷。
-- 详见 docs/plan/2026-10-14-workspace-rules-snapshot-technical-design.md
CREATE TABLE IF NOT EXISTS `session_workspace_rules` (
    `session_id`    BIGINT       NOT NULL COMMENT '会话ID（一行一会话）',
    `workspace`     VARCHAR(512) NOT NULL COMMENT '冻结时的有效工作区绝对路径；与当前值不一致视为无效快照',
    `rules_text`    MEDIUMTEXT   NOT NULL COMMENT '该节完整注入文本（含 ## 工作区规则 标题与 200 行截断提示）',
    `rules_hash`    CHAR(64)     NOT NULL COMMENT 'rules_text 的 sha256（与 prompt-prefix-monitor 同口径，排障用）',
    `source_path`   VARCHAR(512) NULL COMMENT '来源文件绝对路径；LOCAL 模式为 NULL（内容由桌面端上报）',
    `source_mtime`  BIGINT       NULL COMMENT '来源文件 mtime（毫秒）；LOCAL 模式为 NULL',
    `created_at`    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '冻结时刻',
    `updated_at`    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='会话级工作区规则快照（提示词前缀缓存稳定化）';
