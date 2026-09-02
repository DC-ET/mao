-- V099: 废弃 harness.delegate 调参（timeoutSeconds / cancelGraceSeconds）——
-- delegate / delegate_followup 工具已移除，不再产生前台委派执行；所有子代理执行（spawn_subagent /
-- subagent_followup）及 BACKGROUND/FOLLOWUP 崩溃恢复均无超时。仅存的消费点（崩溃后恢复旧遗留 legacy
-- 前台委派执行时按开始时间+超时截断）随本次代码清理一并移除，恢复改为与 BACKGROUND 一致的无限期执行，
-- LLM 调用与工具执行自身超时仍兜底。

DELETE FROM `system_setting` WHERE `setting_key` IN ('harness.delegate.timeoutSeconds', 'harness.delegate.cancelGraceSeconds');
