-- message_queue.content 与 message.content（V001）对齐为 MEDIUMTEXT：
-- TEXT 上限 65535 字节，UTF-8 中文每字最多 3 字节；开放调用门禁允许 32000 字消息，
-- busy 入队路径可达 96000 字节，MySQL 严格模式下 INSERT 直接被拒（Data too long），
-- 排队消息永久丢失且会话卡在忙状态。改列不影响存量行（TEXT ⊂ MEDIUMTEXT）。
ALTER TABLE message_queue MODIFY COLUMN content MEDIUMTEXT NOT NULL;
