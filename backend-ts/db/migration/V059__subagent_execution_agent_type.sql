-- 子智能体执行记录增加 agent_type，供列表与 Tab 展示
ALTER TABLE `subagent_execution`
    ADD COLUMN `agent_type` VARCHAR(64) DEFAULT NULL COMMENT '子代理类型' AFTER `child_session_id`;
