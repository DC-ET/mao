-- V051: Persist transient session runtime hint state for refresh recovery

ALTER TABLE `session`
    ADD COLUMN `runtime_status_json` JSON NULL COMMENT 'Transient runtime hints such as compaction/retry, recoverable after refresh';
