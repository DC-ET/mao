-- 语音回复默认关闭：修正 V064 已部署环境的列默认值
ALTER TABLE user_weixin_preference
    MODIFY COLUMN voice_reply TINYINT NOT NULL DEFAULT 0 COMMENT 'Agent 回复是否附带语音：0=关闭 1=开启';
