-- V180: 回填飞书通道历史会话的「来源」标记（source）。
-- 背景：V109 给 session 加 source 列，默认 'web'；直到 0.0.381 才在飞书建会话的调用点补写 'feishu'。
-- 其间创建的飞书会话（私聊 / 群聊 / 话题）全部停在默认值 'web'，管理后台「来源」列与筛选把它们算进 Web。
-- 圈定口径：只认飞书通道自己的映射表（会话→通道绑定、群会话指针、话题映射），
-- 不按 workspace / project_key 模糊匹配——同名工作区里由桌面端新建的会话必须保持 web。
-- 范围：仅 source='web' 的主会话；子代理 / 边路任务的来源口径按各自创建入口，不在此列。
-- 软删除行一并纠正标签（已核对：命中行中不存在 web 之外的其它来源，不会误改 embed / signal / openapi）。
-- 幂等：回填后重复执行不再命中任何行。
UPDATE `session` s
SET s.source = 'feishu'
WHERE s.source = 'web'
  AND s.session_type = 'NORMAL'
  AND (
    EXISTS (SELECT 1 FROM `feishu_session_channel` c WHERE c.session_id = s.id)
    OR EXISTS (SELECT 1 FROM `feishu_chat` f WHERE f.session_id = s.id)
    OR EXISTS (SELECT 1 FROM `feishu_thread_session` t WHERE t.session_id = s.id)
  );
