import { describe, expect, it, vi } from 'vitest';
import { MessageQueueService } from './message-queue.service.js';
import type { MessageQueueRepository } from './message-queue.repository.js';
import type { MessageQueue } from './types.js';

function queue(id: number, sessionId: number, order: number, status: string): MessageQueue {
  return { id, sessionId, sortOrder: order, status };
}

describe('MessageQueueService', () => {
  const repo = {
    findById: vi.fn(),
    insert: vi.fn(async (item) => {
      item.id = 99;
      return 99;
    }),
    updateById: vi.fn(),
    findLastPending: vi.fn(),
    findHeadPending: vi.fn(),
    listPending: vi.fn(),
    listPendingForUpdate: vi.fn(),
    clearPending: vi.fn(),
    findLastPendingForUpdate: vi.fn(),
    findFirstPendingForUpdate: vi.fn(),
    transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(repo)),
  };
  const service = new MessageQueueService(repo as unknown as MessageQueueRepository);

  it('enqueueAppendsAfterLastPendingItem', async () => {
    vi.mocked(repo.findLastPendingForUpdate).mockResolvedValue(queue(1, 10, 4, 'PENDING'));
    const item = await service.enqueue(10, 20, 'hello', '[img]');
    expect(item.sessionId).toBe(10);
    expect(item.userId).toBe(20);
    expect(item.content).toBe('hello');
    expect(item.images).toBe('[img]');
    expect(item.sortOrder).toBe(5);
    expect(item.status).toBe('PENDING');
    expect(repo.insert).toHaveBeenCalledWith(item);
  });

  it('enqueueHeadInsertsBeforeCurrentHead', async () => {
    vi.mocked(repo.insert).mockClear();
    vi.mocked(repo.findFirstPendingForUpdate).mockResolvedValue(queue(2, 10, 1, 'PENDING'));
    await service.enqueueHead(10, 20, 'urgent', null);
    expect(repo.insert).toHaveBeenCalledWith(expect.objectContaining({ sortOrder: 0, content: 'urgent' }));
  });

  it('dequeueMarksHeadDeletedWhenPresent', async () => {
    const head = queue(2, 10, 1, 'PENDING');
    vi.mocked(repo.findHeadPending).mockResolvedValue(head);
    const result = await service.dequeue(10);
    expect(result).toBe(head);
    expect(head.status).toBe('DELETED');
    expect(repo.updateById).toHaveBeenCalledWith(head);
  });

  it('deleteIgnoresMissingItemAndDeletesExistingItem', async () => {
    vi.mocked(repo.updateById).mockClear();
    vi.mocked(repo.findById).mockResolvedValueOnce(null);
    await service.delete(1);
    expect(repo.updateById).not.toHaveBeenCalled();

    const item = queue(2, 10, 1, 'PENDING');
    vi.mocked(repo.findById).mockResolvedValueOnce(item);
    await service.delete(2);
    expect(item.status).toBe('DELETED');
    expect(repo.updateById).toHaveBeenCalledWith(item);
  });

  it('moveToIndexRewritesSortOrderForAllShiftedRows', async () => {
    const a = queue(1, 10, 1, 'PENDING');
    const b = queue(2, 10, 2, 'PENDING');
    const c = queue(3, 10, 3, 'PENDING');
    vi.mocked(repo.findById).mockResolvedValue(b);
    vi.mocked(repo.listPendingForUpdate).mockResolvedValue([a, b, c]);
    await service.moveToIndex(2, 2);
    // b 从下标 1 移到队尾：a 位置未变且 sort_order 已规范，不应重写
    expect(a.sortOrder).toBe(1);
    expect(b.sortOrder).toBe(3);
    expect(c.sortOrder).toBe(2);
    expect(repo.updateById).toHaveBeenCalledWith(b);
    expect(repo.updateById).toHaveBeenCalledWith(c);
    expect(repo.updateById).not.toHaveBeenCalledWith(a);
  });

  it('moveToIndexClampsOutOfRangeIndexToBoundary', async () => {
    const a = queue(1, 10, 1, 'PENDING');
    const b = queue(2, 10, 2, 'PENDING');
    vi.mocked(repo.findById).mockResolvedValue(a);
    vi.mocked(repo.listPendingForUpdate).mockResolvedValue([a, b]);
    await service.moveToIndex(1, 99);
    expect(a.sortOrder).toBe(2);
    expect(b.sortOrder).toBe(1);
  });

  it('moveToIndexIgnoresMissingDeletedOrConsumedItem', async () => {
    vi.mocked(repo.updateById).mockClear();
    vi.mocked(repo.findById).mockResolvedValueOnce(null);
    await service.moveToIndex(10, 0);

    // 行还在但已非 PENDING（被消费/删除）：不在锁定列表内，静默忽略
    vi.mocked(repo.findById).mockResolvedValueOnce(queue(11, 10, 2, 'DELETED'));
    vi.mocked(repo.listPendingForUpdate).mockResolvedValueOnce([queue(12, 10, 1, 'PENDING')]);
    await service.moveToIndex(11, 0);

    vi.mocked(repo.findById).mockResolvedValueOnce(queue(13, 10, 3, 'PENDING'));
    vi.mocked(repo.listPendingForUpdate).mockResolvedValueOnce([queue(12, 10, 1, 'PENDING')]);
    await service.moveToIndex(13, 0);
    expect(repo.updateById).not.toHaveBeenCalled();
  });

  it('moveToIndexNoopWhenAlreadyAtTargetIndex', async () => {
    vi.mocked(repo.updateById).mockClear();
    const a = queue(1, 10, 1, 'PENDING');
    const b = queue(2, 10, 2, 'PENDING');
    vi.mocked(repo.findById).mockResolvedValue(b);
    vi.mocked(repo.listPendingForUpdate).mockResolvedValue([a, b]);
    await service.moveToIndex(2, 1);
    expect(repo.updateById).not.toHaveBeenCalled();
  });

  it('moveToIndexRetriesOnLockDeadlockAndSucceeds', async () => {
    const deadlock = Object.assign(new Error('Deadlock'), { code: 'ER_LOCK_DEADLOCK' });
    vi.mocked(repo.transaction).mockClear();
    vi.mocked(repo.transaction).mockImplementationOnce(async () => { throw deadlock; });
    const a = queue(1, 10, 1, 'PENDING');
    const b = queue(2, 10, 2, 'PENDING');
    vi.mocked(repo.findById).mockResolvedValue(a);
    vi.mocked(repo.listPendingForUpdate).mockResolvedValue([a, b]);
    await service.moveToIndex(1, 1);
    expect(a.sortOrder).toBe(2);
    expect(repo.transaction).toHaveBeenCalledTimes(2);
  });

  it('moveToIndexRethrowsAfterRetriesExhausted', async () => {
    const deadlock = Object.assign(new Error('Deadlock'), { code: 'ER_LOCK_DEADLOCK' });
    vi.mocked(repo.transaction).mockClear();
    vi.mocked(repo.transaction).mockImplementationOnce(async () => { throw deadlock; });
    vi.mocked(repo.transaction).mockImplementationOnce(async () => { throw deadlock; });
    vi.mocked(repo.transaction).mockImplementationOnce(async () => { throw deadlock; });
    await expect(service.moveToIndex(1, 0)).rejects.toBe(deadlock);
    expect(repo.transaction).toHaveBeenCalledTimes(3);
  });

  it('moveToIndexDoesNotRetryOnNonLockErrors', async () => {
    const boom = new Error('boom');
    vi.mocked(repo.transaction).mockClear();
    vi.mocked(repo.transaction).mockImplementationOnce(async () => { throw boom; });
    await expect(service.moveToIndex(1, 0)).rejects.toBe(boom);
    expect(repo.transaction).toHaveBeenCalledTimes(1);
  });

  it('listGetAndClearDelegateToMapper', async () => {
    const rows = [queue(5, 10, 1, 'PENDING')];
    const byId = queue(6, 10, 2, 'PENDING');
    vi.mocked(repo.listPending).mockResolvedValue(rows);
    vi.mocked(repo.findById).mockResolvedValue(byId);
    expect(await service.listPending(10)).toEqual(rows);
    expect(await service.getById(6)).toBe(byId);
    await service.clear(10);
    expect(repo.clearPending).toHaveBeenCalledWith(10);
  });
});
