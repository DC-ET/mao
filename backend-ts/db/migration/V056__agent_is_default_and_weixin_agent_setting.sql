-- Agent 增加默认标记；系统设置增加微信智能体配置

ALTER TABLE `agent`
    ADD COLUMN `is_default` TINYINT NOT NULL DEFAULT 0 COMMENT '是否默认 Agent：0=否 1=是' AFTER `skill_names`;

-- 若尚无默认 Agent，将最早创建的一条设为默认
UPDATE `agent`
SET `is_default` = 1
WHERE `deleted` = 0
  AND NOT EXISTS (
      SELECT 1 FROM (SELECT `id` FROM `agent` WHERE `is_default` = 1 AND `deleted` = 0 LIMIT 1) AS t
  )
ORDER BY `id`
LIMIT 1;

INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`) VALUES
('weixin.agentId', '', '微信', '微信通道使用的智能体 ID，留空则使用默认 Agent', 1);
