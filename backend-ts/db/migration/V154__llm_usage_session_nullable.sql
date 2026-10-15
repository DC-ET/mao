-- 非会话 LLM 调用放行空 session_id。
--
-- llm_usage 是「非 chat / background LLM 调用」的统一用量账本，其中经验起草
-- （scene=feedback_experience_draft）是管理后台动作，天然没有关联会话。
-- V073 建表时把 session_id 定为 NOT NULL，导致 record(userId, null, ...) 落库
-- 直接抛 `Column 'session_id' cannot be null`；该异常发生在 finally 中，会顶掉
-- 真正的业务异常（如 LLM_CALL_FAILED），最终以 500「服务内部错误」暴露。
--
-- 改列可空即可，既有聚合查询（按 created_at / model_id）不依赖该列非空，
-- 索引 idx_llm_usage_session 保留不变。

ALTER TABLE `llm_usage`
    MODIFY COLUMN `session_id` BIGINT NULL COMMENT '关联会话 ID；非会话调用（如反馈转经验起草）为 NULL';
