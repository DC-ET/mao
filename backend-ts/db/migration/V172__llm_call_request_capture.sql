-- V172: llm_call 请求构成采集（技术方案 2026-10-25-run-trace-content-and-prompt §5.1）。
-- 消费方 RecordingLlmAdapter：从 ChatRequest 读全部 role=system 消息 join 成 system_prompt
-- （应用层截断 262144 字符，尾带「…[已截断，原长 N 字符]」标记），tools_json 存
-- request.tools 顺序的工具名清单（JSON 字符串数组）。运行轨迹记录详情抽屉的
-- 「请求构成」tab 按需读（run-trace-record.service.ts），轨迹主 VO 不带正文。
-- NULL = 未记录：历史行不回填，前端显示「该调用未记录请求构成（历史行）」，不猜。
ALTER TABLE `llm_call`
    ADD COLUMN `system_prompt` MEDIUMTEXT NULL
        COMMENT '本轮请求的系统提示词原文（全部 system 消息按序 join；超上限截断并带标记）。NULL = 未记录（历史行 / 无 system 消息）' AFTER `error_message`,
    ADD COLUMN `tools_json` JSON NULL
        COMMENT '本轮请求的工具名清单（request.tools 顺序的 JSON 字符串数组）。NULL = 未记录（历史行 / 无工具）' AFTER `system_prompt`;
