-- 子代理角色重命名：researcher → explorer，coder → worker
-- reviewer 为正式内置角色，历史行保持不变
UPDATE `subagent_execution`
SET `agent_type` = 'explorer'
WHERE `agent_type` = 'researcher';

UPDATE `subagent_execution`
SET `agent_type` = 'worker'
WHERE `agent_type` = 'coder';
