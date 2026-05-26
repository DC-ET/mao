-- V012: 修复 max_rounds 过小导致工具调用后 Agent 立即结束的问题
-- max_rounds 表示 LLM 调用轮次；值为 1 时只能完成「决策调工具」，无法进入「根据工具结果继续回答」

UPDATE `agent`
SET `max_rounds` = 30
WHERE `max_rounds` IS NULL OR `max_rounds` < 2;
