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
    findNeighborUp: vi.fn(),
    findNeighborDown: vi.fn(),
    listPending: vi.fn(),
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

  it('reorderSwapsSortOrderWithNeighbor', async () => {
    const current = queue(3, 10, 2, 'PENDING');
    const neighbor = queue(4, 10, 1, 'PENDING');
    vi.mocked(repo.findById).mockResolvedValue(current);
    vi.mocked(repo.findNeighborUp).mockResolvedValue(neighbor);
    await service.reorder(3, 'up');
    expect(current.sortOrder).toBe(1);
    expect(neighbor.sortOrder).toBe(2);
    expect(repo.updateById).toHaveBeenCalledWith(current);
    expect(repo.updateById).toHaveBeenCalledWith(neighbor);
  });

  it('reorderIgnoresMissingDeletedOrEdgeItem', async () => {
    vi.mocked(repo.updateById).mockClear();
    vi.mocked(repo.findById).mockResolvedValueOnce(null);
    await service.reorder(10, 'down');

    vi.mocked(repo.findById).mockResolvedValueOnce(queue(11, 10, 2, 'DELETED'));
    await service.reorder(11, 'down');

    const current = queue(12, 10, 2, 'PENDING');
    vi.mocked(repo.findById).mockResolvedValueOnce(current);
    vi.mocked(repo.findNeighborDown).mockResolvedValueOnce(null);
    await service.reorder(12, 'down');
    expect(repo.updateById).not.toHaveBeenCalled();
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
