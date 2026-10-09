-- V142: message / llm_call 的 created_at 提升到毫秒精度（DATETIME(3)）。
--
-- 动机：运行轨迹要把工具组挂到具体的模型调用轮上，靠 created_at 跨表比先后。
-- 秒级精度下，llm_call.created_at（调用结束时刻）与 message.created_at（助手消息
-- 落库时刻）几乎总落在同一秒——agent-loop 的流收尾与 afterStream 落库在同一个
-- 程序块里先后执行，实测 164 条带工具调用的助手消息全部如此。秒级无法判定先后，
-- 工具组只能全部留「未挂到轮」。
--
-- 三点保证：
-- 1. 存量数据零损失：DATETIME → DATETIME(3) 是精度扩展，MySQL 直接把秒补成 .000，
--    不做任何 UPDATE。历史行的秒级时间戳原样保留。
-- 2. 新数据真正有毫秒：列默认值必须同步从 CURRENT_TIMESTAMP 改为 CURRENT_TIMESTAMP(3)，
--    否则 MySQL 仍按秒截断后补 .000。两列都由服务端 DEFAULT 生成（应用不传值）。
-- 3. 字典序不变：'yyyy-MM-dd HH:mm:ss.fff' 与 'yyyy-MM-dd HH:mm:ss' 的字典序即时间序，
--    RunTraceService 的 isBefore / notAfter / eqTs、以及 llm_call 窗口查询
--    （created_at >= ? AND created_at < ?）都继续成立，无需改任何比较逻辑。
--
-- message.updated_at 一并提升：它是编辑重发切「编辑前」段的边界，同样参与秒级比较。
ALTER TABLE `message`
    MODIFY COLUMN `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '消息创建时间（毫秒精度，服务端生成）',
    MODIFY COLUMN `updated_at` DATETIME(3) NULL COMMENT '消息更新时间，仅用户消息编辑时填充；毫秒精度';

ALTER TABLE `llm_call`
    MODIFY COLUMN `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '调用结束时刻（毫秒精度，服务端生成）';

-- 索引随列类型自动重建，无需单独 DROP / ADD。
