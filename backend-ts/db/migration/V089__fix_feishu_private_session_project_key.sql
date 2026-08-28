-- 修复存量飞书私聊会话 project_key：建会话时传入的显式 cloudProjectKey 被
-- 工作区路径尾段推导覆盖（private-{userId}），导致分组判定不匹配
-- feishu-{botId}-private-{userId}，私聊会话被误归入"飞书群聊"分组。
-- 依据私聊工作区路径 …/feishu-chat/{botId}/private-{userId} 重建 project_key。
UPDATE `session`
SET project_key = CONCAT(
      'feishu-',
      SUBSTRING_INDEX(SUBSTRING_INDEX(workspace, '/', -2), '/', 1),
      '-',
      SUBSTRING_INDEX(workspace, '/', -1)
    ),
    updated_at = updated_at
WHERE execution_mode = 'CLOUD'
  AND workspace LIKE '%/feishu-chat/%/private-%'
  AND project_key NOT REGEXP '^feishu-[0-9]+-private-[0-9]+$';
