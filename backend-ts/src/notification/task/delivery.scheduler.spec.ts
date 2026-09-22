import { describe, expect, it, vi } from 'vitest';
import { DeliverySchedulerDbStore, WebhookDeliveryScheduler } from './delivery.scheduler.js';
import { DeliveryStatus, webhookSuccess } from './types.js';

describe('DeliverySchedulerDbStore', () => {
  it('covers recover list claim count update and delete', async () => {
    const db = {
      query: vi.fn(async () => []),
      queryOne: vi.fn(async () => ({ c: 3 })),
      execute: vi.fn(async () => ({ affectedRows: 1 })),
      updateById: vi.fn(),
    };
    const store = new DeliverySchedulerDbStore(db as never);
    await store.recoverInterrupted('a', 'b');
    await store.listDue('now', 10);
    expect(await store.claim(1, DeliveryStatus.PENDING)).toBe(true);
    expect(await store.countPending()).toBe(3);
    await store.updateById({ id: 1, status: DeliveryStatus.SUCCEEDED });
    await store.deleteHistory('cutoff');
  });

  it('updateIfStatus_casWritesSnakeColumnsAndReportsAffectedRows', async () => {
    const db = {
      execute: vi.fn(async () => ({ affectedRows: 0 })),
    };
    const store = new DeliverySchedulerDbStore(db as never);
    const ok = await store.updateIfStatus(7, DeliveryStatus.SENDING, {
      id: 7,
      status: DeliveryStatus.SUCCEEDED,
      attemptCount: 2,
      lastHttpStatus: 200,
      sentAt: '2026-09-01 00:00:00',
      nextRetryAt: null,
    });
    expect(ok).toBe(false);
    const [sql, params] = db.execute.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('`status` = ?');
    expect(sql).toContain('`attempt_count` = ?');
    expect(sql).toContain('`last_http_status` = ?');
    expect(sql).toContain('`sent_at` = ?');
    expect(sql).toContain('`next_retry_at` = ?');
    expect(sql).not.toContain('`id` = ?');
    expect(sql).toContain('WHERE id = ? AND status = ?');
    expect(params[params.length - 2]).toBe(7);
    expect(params[params.length - 1]).toBe(DeliveryStatus.SENDING);
  });
});

describe('WebhookDeliveryScheduler', () => {
  it('startStopAndDispatchEmptyQueue', async () => {
    const store = {
      recoverInterrupted: vi.fn(async () => undefined),
      listDue: vi.fn(async () => []),
      claim: vi.fn(),
      countPending: vi.fn(async () => 0),
      updateById: vi.fn(),
      deleteHistory: vi.fn(),
    };
    const scheduler = new WebhookDeliveryScheduler(
      store as never,
      { workerDelayMs: 1000, batchSize: 10, maxAttempts: 3 },
      { decrypt: vi.fn() } as never,
      { get: vi.fn() } as never,
    );
    scheduler.start();
    await scheduler.dispatchDueDeliveries();
    expect(store.listDue).toHaveBeenCalled();
    scheduler.stop();
  });

  it('dispatchUsesDynamicPropertiesProvider', async () => {
    const store = {
      recoverInterrupted: vi.fn(async () => undefined),
      listDue: vi.fn(async () => []),
      claim: vi.fn(),
      countPending: vi.fn(async () => 0),
      updateById: vi.fn(),
      deleteHistory: vi.fn(),
    };
    let batchSize = 5;
    const scheduler = new WebhookDeliveryScheduler(
      store as never,
      async () => ({ workerDelayMs: 1000, batchSize, maxAttempts: 3 }),
      { decrypt: vi.fn() } as never,
      { get: vi.fn() } as never,
    );
    await scheduler.dispatchDueDeliveries();
    expect(store.listDue).toHaveBeenCalledWith(expect.anything(), 5);
    batchSize = 9;
    await scheduler.dispatchDueDeliveries();
    expect(store.listDue).toHaveBeenLastCalledWith(expect.anything(), 9);
    scheduler.stop();
  });

  it('keeps polling after the properties source fails', async () => {
    vi.useFakeTimers();
    const store = {
      recoverInterrupted: vi.fn(async () => undefined),
      listDue: vi.fn(async () => []),
      claim: vi.fn(),
      countPending: vi.fn(async () => 0),
      updateById: vi.fn(),
      deleteHistory: vi.fn(),
    };
    let fail = true;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const scheduler = new WebhookDeliveryScheduler(
      store as never,
      async () => {
        if (fail) throw new Error('ECONNREFUSED');
        return { workerDelayMs: 1000, batchSize: 10, maxAttempts: 3 };
      },
      { decrypt: vi.fn() } as never,
      { get: vi.fn() } as never,
    );
    try {
      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      // 参数读取失败不得中断调度链，否则投递永久停摆
      expect(errorSpy).toHaveBeenCalledWith('任务通知调度参数读取失败，1 分钟后重试', expect.any(Error));
      expect(store.listDue).not.toHaveBeenCalled();
      fail = false;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.listDue).toHaveBeenCalled();
    } finally {
      scheduler.stop();
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('deliverTerminalWriteUsesStatusCasWhenStoreSupportsIt', async () => {
    for (const casOk of [true, false]) {
      const delivery = {
        id: 7, userId: 1, channel: 'DINGTALK', webhookCiphertext: 'enc',
        titleSnapshot: '任务A', terminalPhase: 'COMPLETED', status: DeliveryStatus.SENDING, attemptCount: 0,
      };
      const store = {
        recoverInterrupted: vi.fn(async () => undefined),
        listDue: vi.fn(async () => [delivery]),
        claim: vi.fn(async () => true),
        countPending: vi.fn(async () => 0),
        updateById: vi.fn(async () => undefined),
        deleteHistory: vi.fn(async () => undefined),
        findById: vi.fn(async () => ({ ...delivery })),
        updateIfStatus: vi.fn(async () => casOk),
      };
      const executed: Promise<void>[] = [];
      const scheduler = new WebhookDeliveryScheduler(
        store as never,
        { workerDelayMs: 1000, batchSize: 10, maxAttempts: 3 },
        { decrypt: vi.fn(() => 'https://hook') } as never,
        { get: vi.fn(() => ({ send: vi.fn(async () => webhookSuccess(200, 'ok')) })) } as never,
        undefined,
        (fn: () => void) => { executed.push(fn()); },
      );
      await scheduler.dispatchDueDeliveries();
      await Promise.all(executed);
      expect(store.updateIfStatus).toHaveBeenCalledWith(
        7, DeliveryStatus.SENDING,
        expect.objectContaining({ status: DeliveryStatus.SUCCEEDED }),
      );
      // 走 CAS 路径时不再无条件 updateById（避免覆盖 SUPPRESSED_WS）。
      expect(store.updateById).not.toHaveBeenCalled();
    }
  });

  it('dispatchDueDeliveries_swallowsStoreErrors', async () => {
    const store = {
      recoverInterrupted: vi.fn(async () => undefined),
      listDue: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
      claim: vi.fn(),
      countPending: vi.fn(async () => 0),
      updateById: vi.fn(),
      deleteHistory: vi.fn(),
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const scheduler = new WebhookDeliveryScheduler(
      store as never,
      { workerDelayMs: 1000, batchSize: 10, maxAttempts: 3 },
      { decrypt: vi.fn() } as never,
      { get: vi.fn() } as never,
    );
    await expect(scheduler.dispatchDueDeliveries()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('任务通知投递调度异常', expect.any(Error));
    errorSpy.mockRestore();
  });

  it('cleanupHistory_swallowsStoreErrors', async () => {
    const store = {
      recoverInterrupted: vi.fn(),
      listDue: vi.fn(),
      claim: vi.fn(),
      countPending: vi.fn(),
      updateById: vi.fn(),
      deleteHistory: vi.fn(async () => { throw new Error('ECONNREFUSED'); }),
    };
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const scheduler = new WebhookDeliveryScheduler(
      store as never,
      { workerDelayMs: 1000, batchSize: 10, maxAttempts: 3 },
      { decrypt: vi.fn() } as never,
      { get: vi.fn() } as never,
    );
    await expect(scheduler.cleanupHistory()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalledWith('任务通知历史清理异常', expect.any(Error));
    errorSpy.mockRestore();
  });

  it('deliverTerminalWriteFallsBackToUpdateByIdWithoutCasSupport', async () => {
    const delivery = {
      id: 7, userId: 1, channel: 'FEISHU', webhookCiphertext: 'enc',
      titleSnapshot: '任务A', terminalPhase: 'COMPLETED', status: DeliveryStatus.SENDING, attemptCount: 0,
    };
    const store = {
      recoverInterrupted: vi.fn(async () => undefined),
      listDue: vi.fn(async () => [delivery]),
      claim: vi.fn(async () => true),
      countPending: vi.fn(async () => 0),
      updateById: vi.fn(async () => undefined),
      deleteHistory: vi.fn(async () => undefined),
    };
    const executed: Promise<void>[] = [];
    const scheduler = new WebhookDeliveryScheduler(
      store as never,
      { workerDelayMs: 1000, batchSize: 10, maxAttempts: 3 },
      { decrypt: vi.fn(() => 'https://hook') } as never,
      { get: vi.fn(() => ({ send: vi.fn(async () => webhookSuccess(200, 'ok')) })) } as never,
      undefined,
      (fn: () => void) => { executed.push(fn()); },
    );
    await scheduler.dispatchDueDeliveries();
    await Promise.all(executed);
    expect(store.updateById).toHaveBeenCalledWith(
      expect.objectContaining({ id: 7, status: DeliveryStatus.SUCCEEDED }),
    );
  });

  it('deliverAskUserSendsQuestionNotificationContent', async () => {
    const delivery = {
      id: 9, userId: 1, channel: 'FEISHU', webhookCiphertext: 'enc',
      titleSnapshot: '任务B', terminalPhase: 'ASK_USER', status: DeliveryStatus.PENDING, attemptCount: 0,
    };
    const store = {
      recoverInterrupted: vi.fn(async () => undefined),
      listDue: vi.fn(async () => [delivery]),
      claim: vi.fn(async () => true),
      countPending: vi.fn(async () => 0),
      updateById: vi.fn(async () => undefined),
      deleteHistory: vi.fn(async () => undefined),
    };
    const send = vi.fn(async () => webhookSuccess(200, 'ok'));
    const executed: Promise<void>[] = [];
    const scheduler = new WebhookDeliveryScheduler(
      store as never,
      { workerDelayMs: 1000, batchSize: 10, maxAttempts: 3 },
      { decrypt: vi.fn(() => 'https://hook') } as never,
      { get: vi.fn(() => ({ send })) } as never,
      undefined,
      (fn: () => void) => { executed.push(fn()); },
    );
    await scheduler.dispatchDueDeliveries();
    await Promise.all(executed);
    expect(send).toHaveBeenCalledTimes(1);
    const content = send.mock.calls[0][1] as string;
    expect(content).toContain('提问通知');
    expect(content).toContain('任务B');
    expect(content).toContain('正在等待回答');
    expect(content).not.toContain('已完成');
    expect(store.updateById).toHaveBeenCalledWith(
      expect.objectContaining({ id: 9, status: DeliveryStatus.SUCCEEDED }),
    );
  });
});
