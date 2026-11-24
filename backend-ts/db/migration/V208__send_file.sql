-- 发送附件快照（技术方案 2026-11-24-send-file-snapshot D3）：
-- send_image / send_file 不再引用工作区或公开 uploads 副本，而是发送时另存一份快照，
-- 消息只记 id；对话页经带鉴权的 GET /v1/files/send-download 取字节。
-- user_id 是执行时的运行身份（RUNTIME_SCOPED_TOOLS 口径），下载按属主 + 会话归属人双重授权；
-- session_id 仅作授权补充，可空：会话删除后附件仍属于属主本人，授权自动退回「仅属主」。
CREATE TABLE `send_file` (
    `id` CHAR(36) NOT NULL COMMENT '快照 id（UUID），下载端只认它，不接受客户端传入路径',
    `user_id` BIGINT NOT NULL COMMENT '属主：执行 send 工具时的运行身份',
    `session_id` BIGINT NULL COMMENT '发送时所在会话；仅用于「会话归属人也可下载」的授权补充',
    `filename` VARCHAR(512) NOT NULL COMMENT '展示名，来自工具参数或源文件名',
    `mime` VARCHAR(255) NOT NULL COMMENT '落盘时嗅探/推导的 mime；.bin 固定 application/octet-stream',
    `bytes` BIGINT NOT NULL COMMENT '快照长度',
    `storage` VARCHAR(16) NOT NULL COMMENT '写入时的 upload.storageMode：local|oss|cos|obs',
    `object_key` VARCHAR(512) NOT NULL COMMENT '相对 key {userId}/{uuid}{ext}：本地拼 FILE_SEND_DIR，云拼私有前缀 send-files/',
    `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (`id`),
    KEY `idx_send_file_user` (`user_id`),
    KEY `idx_send_file_session` (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='发送附件快照（不随工作区删除/改写失效）';
