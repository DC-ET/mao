CREATE TABLE message_file_change (
    id            BIGINT       NOT NULL AUTO_INCREMENT PRIMARY KEY,
    message_id    BIGINT       NOT NULL COMMENT '关联的 ASSISTANT 消息 ID',
    session_id    BIGINT       NOT NULL COMMENT '冗余 session_id，便于按会话查询',
    file_path     VARCHAR(512) NOT NULL COMMENT '相对于工作区的文件路径',
    change_type   VARCHAR(16)  NOT NULL COMMENT 'CREATED / MODIFIED',
    lines_added   INT          NOT NULL DEFAULT 0 COMMENT '新增行数',
    lines_deleted INT          NOT NULL DEFAULT 0 COMMENT '删除行数',
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_message_id (message_id),
    INDEX idx_session_id (session_id),
    CONSTRAINT fk_mfc_message FOREIGN KEY (message_id) REFERENCES message(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
