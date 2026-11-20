-- 信号哨兵指定执行会话（docs/plan/2026-11/2026-11-17-signal-watcher-specified-session-technical-design.md §4.1）。
-- specified_session_id 为 SPECIFIED_SESSION 模式的执行会话 id：用户/Agent 指定，保存时校验
-- （存在 + 归属 + 主会话 + CLOUD + Agent 匹配 + 未归档）；与系统维护的 reuse_session_id 分列建模。
-- trigger_mode 放宽到 32：'SPECIFIED_SESSION' 实测 17 字符，V174 的 VARCHAR(16) 严格模式写入即报错。
ALTER TABLE `signal_watcher`
  ADD COLUMN `specified_session_id` BIGINT NULL
    COMMENT 'SPECIFIED_SESSION 模式的执行会话 id（用户/Agent 指定，保存时校验；失效触发判失败不降级新建）',
  MODIFY COLUMN `trigger_mode` VARCHAR(32) NOT NULL DEFAULT 'NEW_SESSION'
    COMMENT '触发方式：NEW_SESSION=每次新建会话，REUSE_SESSION=复用本哨兵自己的会话，SPECIFIED_SESSION=指定执行会话';
