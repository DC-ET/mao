-- 模型类型：text=文本模型（LLM），audio=语音模型（TTS/ASR）
ALTER TABLE llm_model
    ADD COLUMN model_type VARCHAR(16) NOT NULL DEFAULT 'text' COMMENT '模型类型: text=文本模型, audio=语音模型' AFTER model_id;

-- 存量语音合成模型标记为 audio
UPDATE llm_model SET model_type = 'audio' WHERE model_id LIKE 'mimo-v2.5-tts%';
