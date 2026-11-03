-- V181: 回填「本地模式」历史会话的来源为 desktop。
-- 背景：V109 起桌面 / CLI / 浏览器共用 source='web'；本期把来源细分为 desktop/cli/android/web。
-- 判据：execution_mode='LOCAL' 的会话只可能由桌面 Electron 或 mao-agent --local 创建——
--   三个机器人通道与开放接口建会话一律显式 CLOUD（app-feishu-messaging.ts /
--   dingtalk/runtime.ts / weixin/session.service.ts:64 / open-run.service.ts:153），
--   安卓壳不支持本地模式，浏览器无本机执行端时 LOCAL 任务直接被拒
--   （streaming-ws-handler.ts:654-663 发送 / 1343-1352 重试两处 isConnected 检查；
--   本机执行端白名单 LOCAL_CAPABLE_CLIENTS = ['electron','cli']，streaming-ws-registry.ts:15）。
-- 已知不精确（已决策接受，见技术方案 2026-11-03 D9）：CLI --local 建的 LOCAL 会话无字段可与桌面区分，
--   会一并被标为 desktop；CLOUD 会话无任何判据，保持 web。
-- 范围：仅 source='web' 且 execution_mode='LOCAL' 的行；软删除行一并纠正（与 V180 同口径）。
-- 幂等：回填后不再命中任何行。逆运算（如需回滚）：
--   UPDATE `session` SET source='web' WHERE source='desktop' AND execution_mode='LOCAL';
-- 执行前先 SELECT COUNT(*) 评估行量；异常庞大时按 id 区间分批，避免长事务锁表。
UPDATE `session` SET `source` = 'desktop'
WHERE `source` = 'web' AND `execution_mode` = 'LOCAL';
