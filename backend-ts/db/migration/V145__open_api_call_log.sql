-- 开放接口入站调用流水（docs/plan/2026-10-09-open-api-call-center-technical-design.md §5）
CREATE TABLE IF NOT EXISTS `open_api_call_log` (
    `id`                   BIGINT PRIMARY KEY AUTO_INCREMENT,
    `token_id`             BIGINT NULL COMMENT 'API Token；查无此 token 时为 NULL',
    `trigger_id`           BIGINT NULL COMMENT '入站 Webhook 触发器',
    `agent_id`             BIGINT NULL COMMENT '路径参数解析失败时为 NULL',
    `user_id`              BIGINT NULL COMMENT 'Token/触发器属主；查无 token 或查无触发器时为 NULL',
    `session_id`           BIGINT NULL COMMENT '受理时即已知（会话先于执行创建）',
    `message_id`           BIGINT NULL COMMENT '直跑保存的用户消息；排队路径终态回写时补',
    `source`               VARCHAR(16) NOT NULL COMMENT 'API/WEBHOOK',
    `source_ip`            VARCHAR(45) NULL COMMENT '客户端 IP（兼容 IPv6）',
    `token_prefix`         VARCHAR(16) NULL COMMENT '无效/自动停用 token 的明文前 12 位',
    `request_summary_json` TEXT NULL COMMENT '脱敏摘要：结构与关键字段，不含全量内容',
    `request_full_json`    MEDIUMTEXT NULL COMMENT '完整请求体（仅该 Token 开启完整记录时落库，仍过黑名单；按字节截断）',
    `http_status`          SMALLINT NULL COMMENT '逻辑 HTTP 状态（错误码映射）',
    `outcome`              VARCHAR(16) NOT NULL COMMENT 'pending/queued/rejected/completed/failed/cancelled',
    `replay_of_id`         BIGINT NULL COMMENT '管理端重放所依据的原流水 id；非空则不计入 Token 自动停用',
    `error_code`           VARCHAR(64) NULL,
    `error_summary`        VARCHAR(512) NULL COMMENT '截断的错误摘要',
    `duration_ms`          INT NULL COMMENT '受理耗时（建行到做出响应决定）',
    `queue_wait_ms`        INT NULL COMMENT '排队时长（入队到被队列消费）',
    `execution_ms`         INT NULL COMMENT '端到端耗时（受理到终态），统计 P95 口径',
    `created_at`           DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`           DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    `finished_at`          DATETIME NULL COMMENT '终态回写时刻',
    KEY `idx_oacl_created` (`created_at`),
    KEY `idx_oacl_token` (`token_id`, `created_at`),
    KEY `idx_oacl_trigger` (`trigger_id`, `created_at`),
    KEY `idx_oacl_user` (`user_id`, `created_at`),
    KEY `idx_oacl_agent` (`agent_id`, `created_at`),
    KEY `idx_oacl_outcome` (`outcome`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='开放接口入站调用流水';

ALTER TABLE `api_token`
    ADD COLUMN `auto_disabled_at`          DATETIME NULL COMMENT '自动停用时刻；非空即拒绝服务（403 TOKEN_AUTO_DISABLED）',
    ADD COLUMN `auto_disable_reason`       VARCHAR(128) NULL COMMENT '停用原因，供通知与详情展示',
    ADD COLUMN `failure_count`             INT NOT NULL DEFAULT 0 COMMENT '滚动 1h 窗口失败次数；completed 清零',
    ADD COLUMN `failure_window_started_at` DATETIME NULL COMMENT '失败窗口起点；超过 1h 重置',
    ADD COLUMN `log_full_body`             TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=记录完整请求体（默认关，变更走审计）';

ALTER TABLE `message_queue`
    ADD COLUMN `open_call_log_id` BIGINT NULL DEFAULT NULL COMMENT 'API/WEBHOOK 入队时的调用流水绑定',
    ADD KEY `idx_mq_open_call_log` (`open_call_log_id`);

ALTER TABLE `user_inbox_preference`
    ADD COLUMN `open_api_call_failed_enabled` TINYINT NOT NULL DEFAULT 0 COMMENT '开放调用失败聚合通知（默认关）';

INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '查看开放调用', 'openapi:read', '查看开放接口入站调用流水与统计'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'openapi:read');
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '重放开放调用', 'openapi:replay', '以原 Token 身份重放入站调用'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'openapi:replay');
INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT 1, id FROM `permission` WHERE `code` IN ('openapi:read', 'openapi:replay');

INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`)
VALUES ('openapi.callLogRetentionDays', '90', '开放接口', '开放调用流水保留天数（滚动清理）', 1);
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`)
VALUES ('openapi.tokenAutoDisable.enabled', 'true', '开放接口', 'Token 连续失败自动停用总开关', 1);
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`)
VALUES ('openapi.tokenAutoDisableThreshold', '10', '开放接口', 'Token 连续失败自动停用阈值（次/小时）', 1);
