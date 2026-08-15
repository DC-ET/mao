-- 初始化默认基础模型（幂等：已存在同 model_id 则跳过）

INSERT INTO `llm_model` (
    `name`,
    `provider`,
    `base_url`,
    `api_key`,
    `model_id`,
    `status`,
    `context_window_tokens`,
    `supports_vision`,
    `is_default`
)
SELECT
    'deepseek-v4-flash',
    'deepseek',
    'https://api.deepseek.com',
    'sk-xxxxxxxxxxxx',
    'deepseek-v4-flash',
    1,
    NULL,
    0,
    CASE
        WHEN NOT EXISTS (SELECT 1 FROM `llm_model` WHERE `is_default` = 1) THEN 1
        ELSE 0
    END
FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM `llm_model` WHERE `model_id` = 'deepseek-v4-flash');
