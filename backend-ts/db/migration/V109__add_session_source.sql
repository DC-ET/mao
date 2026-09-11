-- Embed SDK 历史会话列表：会话来源标记
-- web=桌面/Web 端创建（默认，含机器人通道），embed=Embed SDK 浮窗创建
ALTER TABLE `session`
  ADD COLUMN `source` VARCHAR(16) NOT NULL DEFAULT 'web' COMMENT '会话来源：web=桌面/Web端，embed=Embed SDK'
  AFTER `session_type`;

-- Embed SDK 浮窗历史列表查询：user + agent + source 过滤后按 updated_at 倒序
CREATE INDEX idx_session_user_agent_source_updated
  ON `session` (`user_id`, `agent_id`, `source`, `updated_at`);
