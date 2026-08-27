import { describe, expect, it, vi } from 'vitest';
import { FeishuTaskQueueService } from './inbound-queue.service.js';
import type { FeishuInboundQueueRepository } from './inbound-queue.repository.js';
import type { FeishuInboundQueueRow } from './types.js';

function repo(overrides: Partial<Record<keyof FeishuInboundQueueRepository, unknown>> = {}): FeishuInboundQueueRepository {
  const base: Record<keyof FeishuInboundQueueRepository, unknown> = {
    transaction: vi.fn(),
    findMaxRankForUpdate: vi.fn(async () => 0),
    findMinRankForUpdate: vi.fn(async () => 1),
    insert: vi.fn(async () => 1),
    setCardMessageId: vi.fn(async () => undefined),
    claimNextQueued: vi.fn(async () => null),
    deleteById: vi.fn(async () => undefined),
    countPending: vi.fn(async () => 0),
    findById: vi.fn(async () => null),
    findByCardMessageId: vi.fn(async () => null),
    findByBotAndMessage: vi.fn(async () => null),
    jumpToFront: vi.fn(async () => false),
    cancelQueued: vi.fn(async () => false),
    listRunning: vi.fn(async () => []),
    resetRunningToQueued: vi.fn(async () => false),
    findPersistedMessageByQueueId: vi.fn(async () => null),
    deleteTerminal: vi.fn(async () => 0),
    listRecoverable: vi.fn(async () => []),
  };
  const instance = { ...base, ...overrides };
  // 默认 transaction 用同一个 repo 作为 tx，保证 findMaxRankForUpdate/insert 走 mock。
  (instance as { transaction: unknown }).transaction = vi.fn(async (fn: (tx: FeishuInboundQueueRepository) => Promise<unknown>) => fn(instance as unknown as FeishuInboundQueueRepository));
  return instance as unknown as FeishuInboundQueueRepository;
}

function row(overrides: Partial<FeishuInboundQueueRow> = {}): FeishuInboundQueueRow {
  return { id: 1, botId: 1, sessionId: 7, messageId: 'om_1', cardMessageId: null, senderOpenId: 'ou_1', maoUserId: null, rankNo: 1, status: 'QUEUED', payload: '{}', ...overrides };
}

describe('FeishuTaskQueueService', () => {
  it('enqueues appending to rank max + 1', async () => {
    const r = repo({ findMaxRankForUpdate: vi.fn(async () => 5), findByBotAndMessage: vi.fn(async () => null), insert: vi.fn(async () => 9) });
    const service = new FeishuTaskQueueService(r);
    const id = await service.enqueue({ sessionId: 7, botId: 1, messageId: 'om_1', senderOpenId: 'ou_1', maoUserId: null, payload: '{}' });
    expect(id).toBe(9);
    expect(r.insert).toHaveBeenCalledWith(expect.objectContaining({ rankNo: 6, status: 'QUEUED' }));
  });

  it('enqueue is idempotent and returns existing id on duplicate redelivery', async () => {
    const r = repo({ findMaxRankForUpdate: vi.fn(async () => 5), findByBotAndMessage: vi.fn(async () => row({ id: 9 })), insert: vi.fn(async () => 10) });
    const service = new FeishuTaskQueueService(r);
    const id = await service.enqueue({ sessionId: 7, botId: 1, messageId: 'om_1', senderOpenId: 'ou_1', maoUserId: null, payload: '{}' });
    expect(id).toBe(9);
    expect(r.insert).not.toHaveBeenCalled();
  });

  it('cancel returns ALREADY_STARTED when row is RUNNING', async () => {
    const r = repo({ findById: vi.fn(async () => row({ status: 'RUNNING' })) });
    const service = new FeishuTaskQueueService(r);
    expect(await service.cancel(1)).toBe('ALREADY_STARTED');
  });

  it('cancel returns NOT_FOUND when row missing', async () => {
    const r = repo({ findById: vi.fn(async () => null) });
    const service = new FeishuTaskQueueService(r);
    expect(await service.cancel(1)).toBe('NOT_FOUND');
  });

  it('cancel returns CANCELLED and deletes row when CAS succeeds', async () => {
    const r = repo({ findById: vi.fn(async () => row()), cancelQueued: vi.fn(async () => true), deleteById: vi.fn(async () => undefined) });
    const service = new FeishuTaskQueueService(r);
    expect(await service.cancel(1)).toBe('CANCELLED');
    expect(r.deleteById).toHaveBeenCalledWith(1);
  });

  it('cancel returns ALREADY_STARTED when CAS fails due to race', async () => {
    const r = repo({ findById: vi.fn(async () => row()), cancelQueued: vi.fn(async () => false) });
    const service = new FeishuTaskQueueService(r);
    expect(await service.cancel(1)).toBe('ALREADY_STARTED');
  });

  it('jumpToFront delegates to repository', async () => {
    const r = repo({ jumpToFront: vi.fn(async () => true) });
    const service = new FeishuTaskQueueService(r);
    expect(await service.jumpToFront(3)).toBe(true);
    expect(r.jumpToFront).toHaveBeenCalledWith(3);
  });

  it('hydrate deletes RUNNING row when message persisted, else resets to QUEUED', async () => {
    const runningRows = [
      row({ id: 1, sessionId: 7 }),
      row({ id: 2, sessionId: 7, messageId: 'om_2' }),
      row({ id: 3, sessionId: 8 }),
    ];
    const r = repo({
      listRunning: vi.fn(async () => runningRows),
      // id=1,3 已落库 → 删除；id=2 未落库 → 复位
      findPersistedMessageByQueueId: vi.fn(async (_sessionId: number, queueId: number) => queueId === 2 ? null : { id: 100 + queueId }),
      deleteById: vi.fn(async () => undefined),
      resetRunningToQueued: vi.fn(async () => true),
      deleteTerminal: vi.fn(async () => 1),
      listRecoverable: vi.fn(async () => [row({ sessionId: 7 }), row({ sessionId: 8, id: 2 }), row({ sessionId: 7, id: 3 })]),
    });
    const service = new FeishuTaskQueueService(r);
    const ids = await service.hydrate();
    expect(r.findPersistedMessageByQueueId).toHaveBeenCalledTimes(3);
    // 已落库行删除
    expect(r.deleteById).toHaveBeenCalledWith(1);
    expect(r.deleteById).toHaveBeenCalledWith(3);
    expect(r.deleteById).not.toHaveBeenCalledWith(2);
    // 未落库行复位
    expect(r.resetRunningToQueued).toHaveBeenCalledTimes(1);
    expect(r.resetRunningToQueued).toHaveBeenCalledWith(2);
    expect(ids).toEqual([7, 8]);
  });

  it('hasPending reflects countPending > 0', async () => {
    const r = repo({ countPending: vi.fn(async () => 3) });
    const service = new FeishuTaskQueueService(r);
    expect(await service.hasPending(7)).toBe(true);
  });
});
