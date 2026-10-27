import { describe, expect, it, vi } from 'vitest';
import type { SignalWatcher } from './types.js';
import type { MysqlSignalWatcherRepository } from './signal.repository.js';
import { WatcherScheduler } from './watcher-scheduler.js';

function watcher(id: number, overrides: Partial<SignalWatcher> = {}): SignalWatcher {
  return {
    id,
    userId: 1,
    agentId: 1,
    name: `w${id}`,
    url: 'https://example.com',
    method: 'GET',
    headersJson: null,
    body: null,
    intervalMinutes: 15,
    compareMode: 'HASH',
    jsonPath: null,
    promptTemplate: 'p',
    status: 'ACTIVE',
    lastValueHash: null,
    lastValueSnippet: null,
    lastCheckedAt: null,
    lastChangedAt: null,
    consecutiveFailures: 0,
    triggerMode: 'NEW_SESSION',
    reuseSessionId: null,
    ...overrides,
  };
}

describe('WatcherScheduler', () => {
  it('dispatches every due watcher', async () => {
    const due = [watcher(1), watcher(2), watcher(3)];
    const repo = { listDue: vi.fn(async () => due) };
    const runCheck = vi.fn(async () => undefined);
    const scheduler = new WatcherScheduler({
      watcherRepo: repo as unknown as MysqlSignalWatcherRepository,
      runCheck,
      execute: (fn) => { void Promise.resolve().then(fn); },
    });
    await scheduler.dispatchDueWatchers();
    await Promise.resolve();
    await Promise.resolve();
    expect(runCheck).toHaveBeenCalledTimes(3);
    expect(scheduler.inFlightCount()).toBe(0);
  });

  it('skips rows without an id', async () => {
    const repo = { listDue: vi.fn(async () => [watcher(1), { ...watcher(2), id: undefined } as SignalWatcher]) };
    const runCheck = vi.fn(async () => undefined);
    const scheduler = new WatcherScheduler({
      watcherRepo: repo as unknown as MysqlSignalWatcherRepository,
      runCheck,
      execute: (fn) => { void Promise.resolve().then(fn); },
    });
    await scheduler.dispatchDueWatchers();
    await Promise.resolve();
    await Promise.resolve();
    expect(runCheck).toHaveBeenCalledTimes(1);
  });

  it('does not start a second probe while one is in flight (single-flight)', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const repo = { listDue: vi.fn(async () => [watcher(1)]) };
    const runCheck = vi.fn(async () => { await gate; });
    const scheduler = new WatcherScheduler({
      watcherRepo: repo as unknown as MysqlSignalWatcherRepository,
      runCheck,
      execute: (fn) => { void fn(); },
    });
    await scheduler.dispatchDueWatchers();
    expect(scheduler.inFlightCount()).toBe(1);
    // 第二轮扫描：同一 watcher 仍在途，不得叠加
    await scheduler.dispatchDueWatchers();
    expect(runCheck).toHaveBeenCalledTimes(1);
    expect(scheduler.inFlightCount()).toBe(1);
    release!();
    await gate;
    await Promise.resolve();
    expect(scheduler.inFlightCount()).toBe(0);
  });

  it('re-entrancy guard: a concurrent dispatch is ignored', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const repo = { listDue: vi.fn(async () => { await gate; return [watcher(1)]; }) };
    const runCheck = vi.fn(async () => undefined);
    const scheduler = new WatcherScheduler({
      watcherRepo: repo as unknown as MysqlSignalWatcherRepository,
      runCheck,
      execute: (fn) => { void fn(); },
    });
    const first = scheduler.dispatchDueWatchers();
    const second = scheduler.dispatchDueWatchers();
    release!();
    await Promise.all([first, second]);
    expect(repo.listDue).toHaveBeenCalledTimes(1);
  });

  it('swallows runCheck errors and clears the in-flight mark', async () => {
    const repo = { listDue: vi.fn(async () => [watcher(1)]) };
    const runCheck = vi.fn(async () => { throw new Error('boom'); });
    const scheduler = new WatcherScheduler({
      watcherRepo: repo as unknown as MysqlSignalWatcherRepository,
      runCheck,
      execute: (fn) => { void fn(); },
    });
    await expect(scheduler.dispatchDueWatchers()).resolves.toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduler.inFlightCount()).toBe(0);
  });

  it('stop() prevents further scheduling', async () => {
    vi.useFakeTimers();
    try {
      const repo = { listDue: vi.fn(async () => [watcher(1)]) };
      const runCheck = vi.fn(async () => undefined);
      const scheduler = new WatcherScheduler({
        watcherRepo: repo as unknown as MysqlSignalWatcherRepository,
        runCheck,
        intervalMs: 1000,
        execute: (fn) => { void fn(); },
      });
      scheduler.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(repo.listDue).toHaveBeenCalledTimes(1);
      scheduler.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(repo.listDue).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restart after stop resumes scanning', async () => {
    vi.useFakeTimers();
    try {
      const repo = { listDue: vi.fn(async () => [watcher(1)]) };
      const scheduler = new WatcherScheduler({
        watcherRepo: repo as unknown as MysqlSignalWatcherRepository,
        runCheck: vi.fn(async () => undefined),
        intervalMs: 1000,
        execute: (fn) => { void fn(); },
      });
      scheduler.start();
      scheduler.stop();
      scheduler.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(repo.listDue).toHaveBeenCalledTimes(1);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes the current time and batch size to listDue', async () => {
    const repo = { listDue: vi.fn(async () => []) };
    const scheduler = new WatcherScheduler({
      watcherRepo: repo as unknown as MysqlSignalWatcherRepository,
      runCheck: vi.fn(async () => undefined),
      execute: (fn) => { void fn(); },
    });
    await scheduler.dispatchDueWatchers();
    expect(repo.listDue).toHaveBeenCalledTimes(1);
    const [now, limit] = repo.listDue.mock.calls[0]!;
    expect(now).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(limit).toBe(50);
  });
});
