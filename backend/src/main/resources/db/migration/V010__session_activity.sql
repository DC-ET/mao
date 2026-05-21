-- V010: Add session_activity table for activity feed

CREATE TABLE IF NOT EXISTS `session_activity` (
  `id`           BIGINT PRIMARY KEY AUTO_INCREMENT,
  `session_id`   BIGINT NOT NULL,
  `type`         VARCHAR(32) NOT NULL COMMENT 'EXPLORE|READ|EDIT|RUN|SEARCH|TOOL',
  `target`       VARCHAR(512) NULL COMMENT '文件路径/命令摘要',
  `summary`      VARCHAR(512) NOT NULL,
  `detail_json`  JSON NULL COMMENT '完整入参/出参引用',
  `status`       VARCHAR(20) DEFAULT 'SUCCESS' COMMENT 'SUCCESS|ERROR|RUNNING',
  `duration_ms`  INT NULL,
  `created_at`   DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_session_created` (`session_id`, `created_at`)
);
