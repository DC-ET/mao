-- V135: 上下文透视与手动治理（P3）——单会话长期记忆注入开关。
-- 语义：0=开启（默认）1=关闭。存取口径同 permission_level；生效时机为「下一次执行」（buildContext 一次性装载）。

ALTER TABLE `session`
    ADD COLUMN `memory_injection_disabled` TINYINT NOT NULL DEFAULT 0
    COMMENT '单会话关闭长期记忆注入：0=开启 1=关闭';
