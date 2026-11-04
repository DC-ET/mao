/**
 * 后端进程时区对齐：在入口（main.ts）最早处引入，先于其余 import 的模块体副作用执行。
 *
 * 为什么需要：全站时间口径是 Asia/Shanghai——`common/json.ts` 的 formatDateTime/shanghaiYmd、
 * `common/structured-logger.ts` 的日志时间戳、`db/db.ts` 连接 `timezone:'+08:00'`（MySQL
 * 会话时区，`CURRENT_TIMESTAMP` 默认值按 +08:00 落库）、usage `rangeWindow` 注释。但
 * `scripts/systemd/mao-backend.service` 不注入 TZ，宿主时区未声明——预算月度窗口
 * （`budget/budget.service.ts` 的 monthStartLocal/currentPeriodLabel/nextMonthStartLocal）
 * 与 `common/datetime.ts` 的 nowSql() 都靠进程本地 getter，宿主非 +08:00 时与 +08:00
 * 落库的时间戳错位：预算在月初 8 小时窗口内整体偏移一个月（误 BLOCK / 超额「复活」），
 * nowSql() 写的 updated_at/completed_at 与 CURRENT_TIMESTAMP 列混排。
 *
 * 做法：Node 支持运行时改 `process.env.TZ`（对后续 Date 操作即生效）。先例：
 * `harness/container/runtime-agent.ts` 容器入口同款对齐（CONTAINER_TIME_ZONE）。
 */
export const PROCESS_TIME_ZONE = 'Asia/Shanghai';

process.env.TZ = PROCESS_TIME_ZONE;
