-- 信号哨兵触发方式可配置 + 复制继承（docs/plan/2026-10-27-signal-watcher-enhancement-technical-design.md §3.2.1）
-- trigger_mode 默认 NEW_SESSION = 现状行为，存量哨兵零迁移自动兼容。
-- reuse_session_id 为 REUSE_SESSION 模式当前复用的会话 id：系统维护（首次触发自动创建并回写），
-- 用户不直接选择，路由层也不接受提交（防伪造指向他人生效中的会话）。
ALTER TABLE `signal_watcher`
  ADD COLUMN `trigger_mode` VARCHAR(16) NOT NULL DEFAULT 'NEW_SESSION'
    COMMENT '触发方式：NEW_SESSION=每次新建会话，REUSE_SESSION=复用本哨兵自己的会话',
  ADD COLUMN `reuse_session_id` BIGINT NULL
    COMMENT 'REUSE_SESSION 模式当前复用的会话 id（系统维护：首次触发自动创建并回写，用户不直接选择）';
