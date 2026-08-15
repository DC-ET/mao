DELETE FROM `session_compaction`;

ALTER TABLE `session_compaction`
    MODIFY COLUMN `last_compacted_msg_id` BIGINT DEFAULT 0
    COMMENT '摘要已覆盖到的最后一条真实 message.id，0 表示未覆盖任何消息';

CREATE INDEX `idx_message_session_deleted_id`
    ON `message` (`session_id`, `deleted`, `id`);
