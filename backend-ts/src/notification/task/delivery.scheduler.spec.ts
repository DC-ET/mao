import { describe, expect, it, vi } from 'vitest';
import { DeliverySchedulerDbStore, WebhookDeliveryScheduler } from './delivery.scheduler.js';
import { DeliveryStatus } from './types.js';

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
});
