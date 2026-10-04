import { describe, expect, it, vi } from 'vitest';
import { InboxCleanupScheduler } from './inbox.cleanup.js';

function store(overrides: Partial<{ deleteHistory: ReturnType<typeof vi.fn> }> = {}) {
  return {
    deleteHistory: overrides.deleteHistory ?? vi.fn(async () => undefined),
  };
}

describe('InboxCleanupScheduler', () => {
  it('startStop显式控制生命周期，stop 后定时清理不再执行', async () => {
    vi.useFakeTimers();
    try {
      const s = store();
      const scheduler = new InboxCleanupScheduler(s as never);
      scheduler.start();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(s.deleteHistory).toHaveBeenCalledTimes(1);
      scheduler.stop();
      await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
      expect(s.deleteHistory).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('按 90 天保留期计算 cutoff（已读/未读都清，单条删除无分批）', async () => {
    const s = store();
    const scheduler = new InboxCleanupScheduler(s as never);
    const before = Date.now();
    await scheduler.cleanupHistory();
    const after = Date.now();
    expect(s.deleteHistory).toHaveBeenCalledTimes(1);
    const [cutoff] = s.deleteHistory.mock.calls[0] as [string];
    // cutoff 是「现在 - 90 天」的 yyyy-MM-dd HH:mm:ss（上海时区，可能比本地时区偏移 8 小时），
    // 只断言日期部分落在 90 天前后的窗口内，避免时区秒差造成脆弱断言。
    const day = cutoff.slice(0, 10);
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const parsed = new Date(`${day}T00:00:00Z`).getTime();
    expect(parsed).toBeLessThanOrEqual(after - 89 * 24 * 3600 * 1000);
    expect(parsed).toBeGreaterThanOrEqual(before - 91 * 24 * 3600 * 1000);
  });

  it('清理异常全吞，不向外抛（调度器不得因一次 DB 抖动停摆）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const s = store({ deleteHistory: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) });
      const scheduler = new InboxCleanupScheduler(s as never);
      await expect(scheduler.cleanupHistory()).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith('收件箱历史清理异常', expect.any(Error));
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('start 后若已被 stop，清理调用直接跳过（stopped 门禁）', async () => {
    const s = store();
    const scheduler = new InboxCleanupScheduler(s as never);
    scheduler.start();
    scheduler.stop();
    await scheduler.cleanupHistory();
    expect(s.deleteHistory).not.toHaveBeenCalled();
  });
});
