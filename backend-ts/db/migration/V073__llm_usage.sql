-- Unified usage records for non-chat/background LLM calls.
CREATE TABLE IF NOT EXISTS `llm_usage` (
  `id`                BIGINT PRIMARY KEY AUTO_INCREMENT,
  `user_id`           BIGINT NOT NULL,
  `session_id`        BIGINT NOT NULL,
  `model_id`          BIGINT NOT NULL,
  `scene`             VARCHAR(64) NOT NULL,
  `prompt_tokens`     INT NOT NULL DEFAULT 0,
  `completion_tokens` INT NOT NULL DEFAULT 0,
  `total_tokens`      INT NOT NULL DEFAULT 0,
  `success`           TINYINT NOT NULL DEFAULT 0,
  `created_at`        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_llm_usage_model` (`model_id`, `created_at`),
  INDEX `idx_llm_usage_session` (`session_id`, `created_at`),
  INDEX `idx_llm_usage_user` (`user_id`, `created_at`)
);
