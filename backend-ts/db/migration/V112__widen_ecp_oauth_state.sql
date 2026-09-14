-- ECP feishu-authorizations 返回的 state 可能远超 64 字符（非 Mao 自生成 UUID）
ALTER TABLE `ecp_oauth_state`
    MODIFY COLUMN `state` VARCHAR(768) NOT NULL COMMENT 'OAuth state（ECP 返回）';
