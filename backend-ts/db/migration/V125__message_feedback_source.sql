-- 点踩反馈来源：桌面端写入 desktop，飞书进度卡点踩写入 feishu，管理后台明细展示来源。
-- 存量行（0.0.208 之前的桌面端点踩）经默认值回填为 desktop，无需数据订正。
-- 不加 source 索引：当前数据量小，明细查询以 created_at 倒序为主路径，按来源筛选后续再加。

ALTER TABLE `message_feedback`
    ADD COLUMN `source` VARCHAR(16) NOT NULL DEFAULT 'desktop' COMMENT '来源：desktop / feishu' AFTER `reason`;

UPDATE `message_feedback` SET `source` = 'desktop' WHERE `source` = '' OR `source` IS NULL;
