-- V141: 模型价格四项化（技术方案 §5.1 / §10 决策 14-16）——缓存读 / 缓存写独立定价，
-- price_input 语义收紧为「非缓存输入价」，llm_call 补 cache_creation_tokens 分项。
--
-- 迁移期推导保证口径连续：把 price_cache_read 推为 price_input×0.5、price_cache_write 推为
-- price_input，逐项展开后与 V138 的 (prompt − 0.5×cached)×pi 完全等价，升级前后同一份
-- usage 算出的成本不变（决策 16）。只影响迁移那一刻，之后由管理员按官方价目自行调整。
ALTER TABLE `llm_model`
    ADD COLUMN `price_cache_read`  DECIMAL(12,6) NULL COMMENT '每百万缓存命中输入 token 价格（成本单位；NULL=该类 token 不计成本）',
    ADD COLUMN `price_cache_write` DECIMAL(12,6) NULL COMMENT '每百万缓存写入输入 token 价格（成本单位；NULL=该类 token 不计成本）';

ALTER TABLE `llm_call`
    ADD COLUMN `cache_creation_tokens` BIGINT NOT NULL DEFAULT 0 COMMENT '缓存写入 token 数（Anthropic cache_creation_input_tokens）；其他协议恒 0';

-- 已配价模型推导缓存价（未配价模型保持 NULL，成本口径本就为不计）。
UPDATE `llm_model`
   SET `price_cache_read`  = ROUND(`price_input` * 0.5, 6),
       `price_cache_write` = `price_input`
 WHERE `price_input` IS NOT NULL;
