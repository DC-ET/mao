-- 信号哨兵：HTTP 探针轮询外部信号，只在判定值变化时触发 Agent 运行
-- （docs/plan/2026-10-11-signal-watcher-technical-design.md §4）
CREATE TABLE IF NOT EXISTS `signal_watcher` (
    `id`                    BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`               BIGINT NOT NULL COMMENT '属主',
    `agent_id`              BIGINT NOT NULL COMMENT '变化时运行的目标 Agent',
    `name`                  VARCHAR(128) NOT NULL COMMENT '哨兵名称',
    `url`                   VARCHAR(1024) NOT NULL COMMENT '探针 URL（http/https）',
    `method`                VARCHAR(8) NOT NULL DEFAULT 'GET' COMMENT 'GET/POST',
    `headers_json`          TEXT NULL COMMENT '请求头（敏感值加密存储，脱敏回显）',
    `body`                  TEXT NULL COMMENT 'POST 体（可含敏感值，加密存储）',
    `interval_minutes`      INT NOT NULL DEFAULT 15 COMMENT '轮询间隔（分钟），钳制 1..1440',
    `compare_mode`          VARCHAR(16) NOT NULL DEFAULT 'HASH' COMMENT 'HASH/JSON_FIELD/STATUS_CODE',
    `json_path`             VARCHAR(255) NULL COMMENT 'compare_mode=JSON_FIELD 时的点分提取路径',
    `prompt_template`       VARCHAR(2000) NOT NULL COMMENT '变化时发给 Agent 的提示词，支持 {diff} {url} {name} 占位',
    `status`                VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE/PAUSED/DISABLED',
    `last_value_hash`       VARCHAR(64) NULL COMMENT '上次判定值哈希；空=待建基线',
    `last_value_snippet`    VARCHAR(1024) NULL COMMENT '上次判定内容片段（截断），供 {diff} 旧值侧使用',
    `last_checked_at`       DATETIME NULL COMMENT '上次轮询时刻（退避写入未来时刻）',
    `last_changed_at`       DATETIME NULL COMMENT '上次判定值变化时刻',
    `consecutive_failures`  INT NOT NULL DEFAULT 0 COMMENT '连续失败次数；成功清零',
    `created_at`            DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`            DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY `idx_watcher_due` (`status`, `last_checked_at`),
    KEY `idx_watcher_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='信号哨兵：HTTP 探针变化触发 Agent';

CREATE TABLE IF NOT EXISTS `signal_watcher_check` (
    `id`                    BIGINT PRIMARY KEY AUTO_INCREMENT,
    `watcher_id`            BIGINT NOT NULL COMMENT '所属哨兵',
    `checked_at`            DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '轮询时刻',
    `http_status`           INT NULL COMMENT '探针 HTTP 状态码；网络失败为 NULL',
    `value_hash`            VARCHAR(64) NULL COMMENT '本次判定值哈希，与 watcher.last_value_hash 比对',
    `changed`               TINYINT NOT NULL DEFAULT 0 COMMENT '本次判定值是否变化',
    `triggered_session_id`  BIGINT NULL COMMENT '变化触发时产生的会话',
    `error`                 VARCHAR(500) NULL COMMENT '失败原因（截断）',
    `duration_ms`           INT NULL COMMENT '探针耗时',
    `warning`               VARCHAR(64) NULL COMMENT '非失败告警：TRIGGER_RATE_LIMITED=触发频次超限',
    KEY `idx_check_watcher` (`watcher_id`, `checked_at`),
    KEY `idx_check_checked_at` (`checked_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='信号哨兵轮询记录';

-- 管理后台只读清单权限（默认授系统管理员角色）
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '查看信号哨兵', 'signal:read', '查看全量信号哨兵清单'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'signal:read');
INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT 1, id FROM `permission` WHERE `code` = 'signal:read';

-- 轮询记录保留天数（滚动清理）
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`)
VALUES ('signal.checkRetentionDays', '90', '信号哨兵', '哨兵轮询记录保留天数（滚动清理）', 1);
