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
});
