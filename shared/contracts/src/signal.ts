/**
 * 信号哨兵契约（前后端共用，desktop / admin 同步消费）。
 *
 * 判定模式与哨兵状态的联合类型放在这里，供两端汉化表以
 * `Record<SignalCompareMode, string>` / `Record<SignalWatcherStatus, string>`
 * 声明——漏一项编译期即失败。
 *
 * 事实源是后端 `backend-ts/src/signal/types.ts`：那里持有运行时常量
 * （`SIGNAL_COMPARE_MODES` / `SIGNAL_WATCHER_STATUSES`）与校验守卫，
 * 并通过 `as const satisfies` 约束到本文件的联合类型。
 */

/** 变化判定模式：内容哈希 / JSON 字段（点分路径 + 数组下标）/ HTTP 状态码。 */
export type SignalCompareMode = 'HASH' | 'JSON_FIELD' | 'STATUS_CODE';

/** 哨兵状态：ACTIVE 轮询中 / PAUSED 用户暂停 / DISABLED 连续失败自动停用（系统终态）。 */
export type SignalWatcherStatus = 'ACTIVE' | 'PAUSED' | 'DISABLED';

/** 轮询记录里的非失败告警码：触发频次超限（照常触发，仅标记）。 */
export type SignalWatcherWarning = 'TRIGGER_RATE_LIMITED';
