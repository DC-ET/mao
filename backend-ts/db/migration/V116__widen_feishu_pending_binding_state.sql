-- ECP feishu-authorizations 返回的 state 与 ecp_oauth_state 一样可能远超 64 字符。
-- 飞书通道引导把该 state 写入 feishu_pending_binding_message 时会被截断/插入失败，
-- 原先 catch 还会把已拿到的登录链接清掉，用户只看到文案没有链接。
ALTER TABLE `feishu_pending_binding_message`
    MODIFY COLUMN `state` VARCHAR(768) NOT NULL COMMENT 'OAuth state（Mao UUID 或 ECP 返回）';
