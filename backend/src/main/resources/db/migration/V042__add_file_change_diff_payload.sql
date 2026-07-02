ALTER TABLE message_file_change
    ADD COLUMN diff_mode VARCHAR(16) NULL COMMENT 'SNAPSHOT / PATCH / UNSUPPORTED' AFTER lines_deleted,
    ADD COLUMN before_content MEDIUMTEXT NULL COMMENT '变更前内容快照' AFTER diff_mode,
    ADD COLUMN after_content MEDIUMTEXT NULL COMMENT '变更后内容快照' AFTER before_content,
    ADD COLUMN patch_content MEDIUMTEXT NULL COMMENT '大文件 unified patch 内容' AFTER after_content,
    ADD COLUMN patch_truncated TINYINT(1) NOT NULL DEFAULT 0 COMMENT 'patch 是否被截断' AFTER patch_content,
    ADD COLUMN diff_unavailable_reason VARCHAR(512) NULL COMMENT '无法生成 diff 的原因' AFTER patch_truncated;
