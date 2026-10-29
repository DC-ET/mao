/**
 * LLM 调用场景契约（前后端共用，desktop / admin 同步消费）。
 *
 * 场景枚举的事实源在后端 `backend-ts/src/usage/llm-call-context.ts` 的
 * `LLM_CALL_SCENES`；这里放同一份联合类型，供两端汉化表以
 * `Record<LlmCallScene, string>` 声明——漏项在编译期即失败，
 * 不再依赖运行时才发现的英文枚举。
 *
 * 新增场景时必须同步三处，缺一不可：
 *   1. 本文件加联合成员（类型契约）；
 *   2. 后端 `LLM_CALL_SCENES` 加映射（事实源）；
 *   3. desktop / admin 的汉化表加中文（展示）。
 * 其中 3 由 `Record<LlmCallScene, string>` 强制；2 与 1 的一致性由
 * 后端 `llm-call-context.spec.ts` 的 exhaustiveness 断言守住。
 */
export type LlmCallScene =
  | 'agent'
  | 'compaction'
  | 'session_title'
  | 'git_commit_message'
  | 'feedback_experience_draft'
  | 'danger_assess'
  | 'proxy_approve'
  | 'voice_synthesis'
  | 'feishu_summarize'
  | 'connectivity_test'
  | 'memory_extract'
  | 'agent_handover_summary'
  | 'unknown';
