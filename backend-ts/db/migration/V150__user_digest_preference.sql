CREATE TABLE IF NOT EXISTS `user_digest_preference` (
    `user_id`          BIGINT       NOT NULL COMMENT '用户ID',
    `enabled`          TINYINT      NOT NULL DEFAULT 1 COMMENT '每日摘要总开关：0=关，1=开（默认开）',
    `push_time`        VARCHAR(5)   NOT NULL DEFAULT '09:30' COMMENT '每日推送时间 HH:MM（Asia/Shanghai 口径比较）',
    `outbound_enabled` TINYINT      NOT NULL DEFAULT 1 COMMENT '是否经出站订阅推送（仅有订阅时生效）',
    `last_digest_date` DATE         NULL COMMENT '最近一次已处理的被汇总日期（昨天）；NULL=从未处理',
    `created_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    `updated_at`       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='用户每日运营摘要偏好';
