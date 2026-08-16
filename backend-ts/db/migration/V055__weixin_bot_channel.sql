-- 微信Bot通道集成相关表

-- 微信账号表
CREATE TABLE IF NOT EXISTS weixin_channel_account (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    user_id BIGINT NOT NULL COMMENT '系统用户ID',
    account_id VARCHAR(128) NOT NULL COMMENT '业务侧绑定账号ID',
    payload_json TEXT NOT NULL COMMENT '账号凭据JSON',
    get_updates_buf TEXT NULL COMMENT 'getupdates游标',
    enabled TINYINT NOT NULL DEFAULT 1 COMMENT '是否启用',
    deleted TINYINT NOT NULL DEFAULT 0 COMMENT '是否删除',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_user_id (user_id),
    KEY idx_account_id (account_id),
    KEY idx_enabled (enabled)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='微信Bot账号表';

-- 上下文Token表
CREATE TABLE IF NOT EXISTS weixin_channel_context_token (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    account_id VARCHAR(128) NOT NULL COMMENT '绑定账号ID',
    wx_user_id VARCHAR(128) NOT NULL COMMENT '微信侧用户ID',
    token TEXT NOT NULL COMMENT 'context_token',
    deleted TINYINT NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY idx_account_id (account_id),
    KEY idx_wx_user_id (wx_user_id),
    UNIQUE KEY uk_account_wx_user (account_id, wx_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='微信Bot上下文Token表';