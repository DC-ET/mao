import { describe, expect, it, vi } from 'vitest';
import { DigestScheduler } from './scheduler.js';
import type { DigestPreferenceRow } from './types.js';

/** 固定“现在”：2026-10-12 10:00（Asia/Shanghai）→ 昨天 = 2026-10-11，当前时刻 10:00。 */
const NOW = new Date('2026-10-12T10:00:00+08:00');
const YESTERDAY = '2026-10-11';

function row(overrides: Partial<DigestPreferenceRow> = {}): DigestPreferenceRow {
  return { userId: 1, enabled: 1, pushTime: '09:30', outboundEnabled: 1, lastDigestDate: null, ...overrides };
}

function makeScheduler(rows: DigestPreferenceRow[], processUser = vi.fn(async () => undefined)) {
  const listEnabledUsers = vi.fn(async () => rows);
  const scheduler = new DigestScheduler({ listEnabledUsers, processUser, now: () => NOW });
  return { scheduler, processUser, listEnabledUsers };
}

describe('DigestScheduler', () => {
  it('昨天未处理且已过推送时间 → 处理', async () => {
    const { scheduler, processUser } = makeScheduler([row({ pushTime: '09:30' })]);
    await scheduler.tick();
    expect(processUser).toHaveBeenCalledWith(1);
  });

  it('未到推送时间 → 跳过', async () => {
    const { scheduler, processUser } = makeScheduler([row({ pushTime: '10:01' })]);
    await scheduler.tick();
    expect(processUser).not.toHaveBeenCalled();
  });

  it('恰好等于推送时间（边界）→ 处理', async () => {
    const { scheduler, processUser } = makeScheduler([row({ pushTime: '10:00' })]);
    await scheduler.tick();
    expect(processUser).toHaveBeenCalledWith(1);
  });

  it('昨天已处理（last_digest_date=昨天）→ 跳过', async () => {
    const { scheduler, processUser } = makeScheduler([row({ lastDigestDate: YESTERDAY })]);
    await scheduler.tick();
    expect(processUser).not.toHaveBeenCalled();
  });

  it('处理的是更早日期 → 仍然处理（补发昨天）', async () => {
    const { scheduler, processUser } = makeScheduler([row({ lastDigestDate: '2026-10-09' })]);
    await scheduler.tick();
    expect(processUser).toHaveBeenCalledWith(1);
  });

  it('多用户逐个处理；单用户异常被隔离且不影响后续用户', async () => {
    const processUser = vi.fn(async (userId: number) => {
      if (userId === 2) throw new Error('boom');
    });
    const { scheduler } = makeScheduler([row({ userId: 1 }), row({ userId: 2 }), row({ userId: 3 })], processUser);
    await scheduler.tick();
    expect(processUser).toHaveBeenCalledTimes(3);
  });

  it('listEnabledUsers 抛错不逃出 tick', async () => {
    const listEnabledUsers = vi.fn(async () => { throw new Error('db down'); });
    const scheduler = new DigestScheduler({ listEnabledUsers, processUser: vi.fn(), now: () => NOW });
    await expect(scheduler.tick()).resolves.toBeUndefined();
  });

  it('stop 后 tick 不再执行', async () => {
    const { scheduler, processUser } = makeScheduler([row()]);
    scheduler.stop();
    await scheduler.tick();
    expect(processUser).not.toHaveBeenCalled();
  });
});
