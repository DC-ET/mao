-- V134: 资产分发闭环（P2）—— bundle URL 导入来源 + 共享条目远端来源 + registry 开关配置。
-- agent_import_origin 只保留每个 Agent 最近一次导入来源（uk agent_id 单行 upsert，无膨胀）。

CREATE TABLE IF NOT EXISTS `agent_import_origin` (
    `id`                     BIGINT PRIMARY KEY AUTO_INCREMENT,
    `agent_id`               BIGINT NOT NULL,
    `source_url`             VARCHAR(1024) NOT NULL,
    `content_hash`           CHAR(64) NOT NULL COMMENT '导入时远端 bundle 的 contentHash（check-updates 比对基准）',
    `imported_system_prompt` MEDIUMTEXT NULL COMMENT '导入时 systemPrompt 快照，用于本地漂移检测（localEdited）',
    `imported_by`            BIGINT NOT NULL,
    `created_at`             DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`             DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_import_origin_agent` (`agent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Agent bundle 导入来源（最近一次）';

ALTER TABLE `shared_agent_entry`
    ADD COLUMN `source_url` VARCHAR(1024) NULL DEFAULT NULL COMMENT '远端来源，非空时支持更新检查';

-- registry 开关（admin 系统设置「Agent 资产」分组）：enabled 默认 false；accessToken 为 secret（尾 4 位掩码回显）。
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`, `is_secret`) VALUES
('bundle.registry.enabled', NULL, 'Agent 资产', 'Bundle registry 只读端点开关（开启后本实例可作为 bundle 只读源，内网可读资产内容）', 1, 0),
('bundle.registry.accessToken', NULL, 'Agent 资产', 'registry 访问 token（可选；非空时拉取须携带 ?token= 或 X-Mao-Registry-Token）', 1, 1);
