-- V183: 群聊会话运行身份对齐（技术方案 docs/plan/2026-11-04-group-chat-runtime-identity-technical-design.md §5.1）。
-- 语义：最近一次执行的「运行身份」= executionUserId ?? session.user_id。
-- 用途：崩溃恢复、子代理继承、失败重试的事实源；不参与列表/权限/查询过滤。
-- 可空：存量行不回填，恢复/重试时回落 session.user_id。

ALTER TABLE `session`
    ADD COLUMN `last_runtime_user_id` INT NULL
    COMMENT '最近一次执行的运行身份（executionUserId ?? user_id）；恢复/子代理/重试事实源';
