-- V214: 特色工具模型绑定 + 图片/语音默认模型（技术方案 2026-11-27「特色工具模型：默认模型 + Agent 指定模型」）。
-- agent.image_model_id / audio_model_id：NULL=跟随对应类型默认模型；绑定后只认绑定模型（失效即能力不可用，不回退）。
-- llm_model.is_default 语义从「全局唯一默认（实际只有文本）」改为「按 model_type 各一个默认」。
ALTER TABLE `agent`
    ADD COLUMN `image_model_id` BIGINT NULL
        COMMENT '指定文生图模型 id；NULL=跟随图片默认模型'
        AFTER `featured_tools`,
    ADD COLUMN `audio_model_id` BIGINT NULL
        COMMENT '指定语音模型 id；NULL=跟随语音默认模型'
        AFTER `image_model_id`;

-- 存量归一：image/audio 若已存在多个非删除默认行（历史只可能经 API/CLI 产生），保留 id 最小的一行。
-- 派生表包裹规避 MySQL「UPDATE 不能直接子查询同表」；外层 WHERE id IS NOT NULL 防 NOT IN 被 NULL 毒化。
UPDATE `llm_model`
SET `is_default` = 0
WHERE `is_default` = 1
  AND `deleted` = 0
  AND `model_type` IN ('image', 'audio')
  AND `id` NOT IN (
      SELECT `id` FROM (
          SELECT MIN(`id`) AS `id` FROM `llm_model` WHERE `is_default` = 1 AND `deleted` = 0 AND `model_type` = 'image'
          UNION ALL
          SELECT MIN(`id`) AS `id` FROM `llm_model` WHERE `is_default` = 1 AND `deleted` = 0 AND `model_type` = 'audio'
      ) `keepers`
      WHERE `id` IS NOT NULL
  );

-- 存量回填：该类型当前没有非删除默认行时，把「当前实际会被使用」的首个启用模型标为默认，保持现网调用结果不变。
-- 文本默认行不动。
UPDATE `llm_model`
SET `is_default` = 1
WHERE `id` = (
    SELECT `id` FROM (
        SELECT `id` FROM `llm_model`
        WHERE `status` = 1 AND `deleted` = 0 AND `model_type` = 'image'
        ORDER BY `id` ASC LIMIT 1
    ) `first_active`
)
AND NOT EXISTS (
    SELECT 1 FROM (
        SELECT `id` FROM `llm_model` WHERE `is_default` = 1 AND `deleted` = 0 AND `model_type` = 'image'
    ) `existing_default`
);

UPDATE `llm_model`
SET `is_default` = 1
WHERE `id` = (
    SELECT `id` FROM (
        SELECT `id` FROM `llm_model`
        WHERE `status` = 1 AND `deleted` = 0 AND `model_type` = 'audio'
          AND (`api_protocol` IS NULL OR `api_protocol` = '' OR `api_protocol` = 'openai-compatible')
        ORDER BY `id` ASC LIMIT 1
    ) `first_active`
)
AND NOT EXISTS (
    SELECT 1 FROM (
        SELECT `id` FROM `llm_model` WHERE `is_default` = 1 AND `deleted` = 0 AND `model_type` = 'audio'
    ) `existing_default`
);
