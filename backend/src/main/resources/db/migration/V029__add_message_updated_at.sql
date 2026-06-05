-- Add updated_at column to message table for edit tracking
ALTER TABLE message ADD COLUMN updated_at DATETIME NULL COMMENT '消息更新时间，仅用户消息编辑时填充';
