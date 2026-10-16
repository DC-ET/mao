-- V157: 移除「负反馈转经验」功能后，删除其起草模型设置项。
-- 转经验（POST /feedback/admin/draft、/feedback/admin/convert 与 admin 向导）已整体下线，
-- feedback.draftModelId 无任何读取方；设置行留在库里会在系统设置页渲染成孤儿输入框，故删除。
-- 历史 llm_usage 行的 scene='feedback_experience_draft' 与 message_feedback 的
-- status='CONVERTED' / experience_id 列均保留，作为存量数据可查（筛选与展示不受影响）。

DELETE FROM `system_setting` WHERE `setting_key` = 'feedback.draftModelId';
