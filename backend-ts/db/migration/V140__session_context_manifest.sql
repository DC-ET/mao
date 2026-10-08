-- 最近一次请求的上下文构成快照。与 context_window 推送同源，刷新后回放，不事后重建。
ALTER TABLE `session`
    ADD COLUMN `context_manifest_json` TEXT NULL COMMENT '最近一次请求的上下文构成快照' AFTER `context_tokens`;
