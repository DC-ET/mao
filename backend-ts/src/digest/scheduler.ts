import { addDaysYmd, formatDateTime, shanghaiYmd } from '../common/json.js';
import type { DigestPreferenceRow } from './types.js';

/** 每分钟扫一次（对齐 InboxCleanupScheduler 的 setInterval 范式；用户量级下单 tick 毫秒级）。 */
const TICK_INTERVAL_MS = 60 * 1000;

export interface DigestSchedulerDeps {
  listEnabledUsers(): Promise<DigestPreferenceRow[]>;
  /** 单用户处理；抛错由调度器捕获隔离（不写防重标记，下分钟重试）。 */
  processUser(userId: number): Promise<unknown>;
  /** 可注入时钟（单测固定“现在”）。 */
  now?: () => Date;
}

/**
 * 每日摘要调度器（技术方案 §5.4）：每分钟 tick，逐用户判定后处理。
 *
 * 判定三条件（全部满足才处理）：
 * 1. 总开关已开（listEnabledUsers 已保证：无偏好行按默认「开」，显式关的用户被排除）；
 * 2. `last_digest_date !== 昨天`——昨天还没处理过（防重；
 *    注意语义是“被汇总日期”而非发送日期：改推送时间当天不补发，次日正常）；
 * 3. 当前上海时刻 ≥ 用户推送时间（HH:MM 字符串字典序即时间序）。
 *
 * 单 tick 内逐用户串行处理，天然单飞（无 CAS / 无 Map 标记的需要）；
 * 单用户异常只记日志不写标记，下一 tick 自动重试。
 */
export class DigestScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly now: () => Date;

  constructor(private readonly deps: DigestSchedulerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => { void this.tick(); }, TICK_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 暴露给单测：手动跑一轮判定（不依赖定时器）。 */
  async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      const now = this.now();
      const yesterday = addDaysYmd(shanghaiYmd(now), -1);
      // formatDateTime 输出 "yyyy-MM-dd HH:mm:ss"，截中间 5 位即上海 HH:MM
      const hm = formatDateTime(now).slice(11, 16);
      const rows = await this.deps.listEnabledUsers();
      for (const row of rows) {
        if (row.lastDigestDate === yesterday) continue;
        if (hm < row.pushTime) continue;
        try {
          await this.deps.processUser(row.userId);
        } catch (e) {
          console.error(`[digest] process user ${row.userId} failed:`, e);
        }
      }
    } catch (e) {
      console.error('[digest] scheduler tick failed:', e);
    }
  }
}
