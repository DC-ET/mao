-- Scheduled task system: support cron-based agent execution
CREATE TABLE scheduled_task (
    id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
    user_id               BIGINT       NOT NULL,
    agent_id              BIGINT       NOT NULL,
    session_id            BIGINT       NOT NULL,
    name                  VARCHAR(200) NOT NULL,
    prompt                TEXT         NOT NULL,
    cron_expression       VARCHAR(100) NOT NULL,
    status                VARCHAR(20)  NOT NULL DEFAULT 'ACTIVE',
    last_fire_time        DATETIME              DEFAULT NULL,
    last_execution_status VARCHAR(20)           DEFAULT NULL,
    next_fire_time        DATETIME              DEFAULT NULL,
    fire_count            INT          NOT NULL DEFAULT 0,
    created_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at            DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    deleted               TINYINT      NOT NULL DEFAULT 0,
    INDEX idx_user_id (user_id),
    INDEX idx_status_next_fire (status, next_fire_time, deleted)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
