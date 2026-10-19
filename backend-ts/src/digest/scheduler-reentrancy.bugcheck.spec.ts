import { describe, expect, it, vi } from 'vitest';
import { DigestScheduler } from './scheduler.js';
import type { DigestPreferenceRow } from './types.js';

/**
 * 回归用例：DigestScheduler 无重入保护，重叠 tick 会对同一用户重复投递日报。
 *
 * 位置：backend-ts/src/digest/scheduler.ts:38,50-70 —— start() 用 setInterval 驱动 tick，
 * 回调不等待上一轮 Promise；tick 内只有 stopped 判定（:51），没有 inFlight/dispatching 标志。
 * 一旦某轮耗时超过 60s（用户多 + 聚合查询慢），下一轮会带着**启动时刻的 rows 快照**并发进入，
 * 对「第一轮尚未处理到、last_digest_date 还没写回」的用户重复调用 processUser：
 *   - digest/service.ts 再次 writeDigestEntry → inbox.repository.ts 的
 *     ON DUPLICATE KEY UPDATE 把用户已读的日报打回未读；
 *   - 再次 dispatchDigest → openapi/outbound-subscription.service.ts 每个 Webhook 订阅
 *     再插一条 outbound_delivery（无唯一键），订阅方收到两份日报。
 * 文件头注释声称「单 tick 内逐用户串行处理，天然单飞」，但 setInterval 不提供这个保证；
 * 同仓其它调度器（schedule/scheduled-task.service.ts、signal/watcher-scheduler.ts、
 * openapi/outbound-delivery.scheduler.ts）都有显式的在途标志。
 *
 * 期望：重叠的第二轮 tick 直接跳过（同一用户 processUser 只调用一次）。
 */
const NOW = new Date('2026-10-12T10:00:00+08:00');

function row(overrides: Partial<DigestPreferenceRow> = {}): DigestPreferenceRow {
  return { userId: 1, enabled: 1, pushTime: '09:30', outboundEnabled: 1, lastDigestDate: null, ...overrides };
}

describe('DigestScheduler reentrancy', () => {
  it('does not double-dispatch one user when a tick overlaps a slow in-flight tick', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const processUser = vi.fn(async () => { await gate; });
    const listEnabledUsers = vi.fn(async () => [row()]);
    const scheduler = new DigestScheduler({ listEnabledUsers, processUser, now: () => NOW });

    const first = scheduler.tick();
    // 等第一轮真正进入 processUser（被 gate 卡住），模拟「一轮 tick 超过 60s」
    await new Promise((resolve) => setImmediate(resolve));
    expect(processUser).toHaveBeenCalledTimes(1);

    const second = scheduler.tick();
    release();
    await Promise.all([first, second]);

    // 第二轮开始时该用户的行还是 lastDigestDate=null（第一轮尚未写回），不得重复处理
    expect(processUser).toHaveBeenCalledTimes(1);
  });
});
