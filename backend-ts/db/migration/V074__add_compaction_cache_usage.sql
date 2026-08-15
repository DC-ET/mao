ALTER TABLE `session_compaction_event`
    ADD COLUMN `prompt_tokens` INT NULL AFTER `compacted_message_count`,
    ADD COLUMN `cached_tokens` INT NULL AFTER `prompt_tokens`,
    ADD COLUMN `completion_tokens` INT NULL AFTER `cached_tokens`;
