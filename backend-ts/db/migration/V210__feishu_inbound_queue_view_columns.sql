-- 飞书入站排队消息的面板展示列（技术方案 2026-11-25 feishu-inbound-queue-web-visibility）。
-- 目的：web/桌面端 QueuePanel 展示飞书排队项时不必读取 MEDIUMTEXT payload（可能含 data URI 图片）。
-- 存量行这些列为 NULL/0，读取时按 id 单查 payload 回退计算；新行入队即写入。
ALTER TABLE `feishu_inbound_queue`
    ADD COLUMN `summary`      VARCHAR(255) NULL COMMENT '入队时截断的正文摘要（面板展示用）',
    ADD COLUMN `sender_label` VARCHAR(64)  NULL COMMENT '发送者展示名',
    ADD COLUMN `image_count`  INT NOT NULL DEFAULT 0 COMMENT '图片数',
    ADD COLUMN `file_count`   INT NOT NULL DEFAULT 0 COMMENT '文件引用数';
