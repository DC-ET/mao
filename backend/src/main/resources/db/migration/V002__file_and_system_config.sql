-- 文件管理表
CREATE TABLE IF NOT EXISTS `file` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `original_name` VARCHAR(256) NOT NULL COMMENT '原始文件名',
    `stored_name`   VARCHAR(256) NOT NULL COMMENT '存储文件名',
    `file_path`     VARCHAR(512) NOT NULL COMMENT '存储路径',
    `file_size`     BIGINT NOT NULL COMMENT '文件大小(字节)',
    `mime_type`     VARCHAR(128) COMMENT 'MIME 类型',
    `uploader_id`   BIGINT NOT NULL COMMENT '上传者用户 ID',
    `session_id`    BIGINT COMMENT '关联会话 ID',
    `created_at`    DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_uploader` (`uploader_id`),
    INDEX `idx_session` (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
