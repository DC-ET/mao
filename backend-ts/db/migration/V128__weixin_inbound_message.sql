-- V128: 微信入站消息认领表：内容指纹幂等键 + CLAIMED/DONE/FAILED 状态机
-- ilink getupdates 协议无服务端 message_id，幂等键为消息内容指纹（SHA-256）。
-- 游标（get_updates_buf）仅在消息入库之后推进；处理失败置 FAILED、中断（无心跳超时）重放。

CREATE TABLE IF NOT EXISTS `weixin_inbound_message` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `account_id`  VARCHAR(128) NOT NULL,
    `message_key` VARCHAR(191) NOT NULL COMMENT '入站消息指纹（item_list 序列化哈希），无服务端 message_id 可用',
    `payload`     MEDIUMTEXT   NOT NULL COMMENT '原始消息 JSON',
    `status`      VARCHAR(16)  NOT NULL DEFAULT 'CLAIMED' COMMENT 'CLAIMED / DONE / FAILED',
    `created_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_weixin_inbound_message` (`account_id`, `message_key`),
    KEY `idx_weixin_inbound_retry` (`status`, `updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='微信入站消息幂等记录';
