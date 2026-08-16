-- 新增文生图模型类型（image）：文生图模型（如 gpt-image-2）
ALTER TABLE llm_model
    MODIFY COLUMN model_type VARCHAR(16) NOT NULL DEFAULT 'text'
        COMMENT '模型类型: text=文本模型, audio=语音模型, image=文生图' AFTER model_id;

-- 新增 GPT image 2 文生图模型（API 地址同 GPT-5.6，mikiko；使用图片专用 key）
INSERT INTO llm_model (name, provider, base_url, api_key, model_id, model_type, context_window_tokens, status, supports_vision, is_default)
SELECT 'GPT image 2', 'mikiko', 'https://mikiko.cc/v1',
       'sk-xxxxxxxxxxxx',
       'gpt-image-2', 'image', NULL, 1, 0, 0
WHERE NOT EXISTS (SELECT 1 FROM llm_model WHERE model_id = 'gpt-image-2');
