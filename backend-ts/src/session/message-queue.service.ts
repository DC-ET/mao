import type { MessageQueue } from './types.js';
import type { MessageQueueRepository } from './message-queue.repository.js';

export class MessageQueueService {
  constructor(private readonly repo: MessageQueueRepository) {}

  async enqueue(sessionId: number, userId: number, content: string, images: string | null): Promise<MessageQueue> {
    const last = await this.repo.findLastPending(sessionId);
    const maxOrder = last?.sortOrder ?? 0;
    const item: MessageQueue = {
      sessionId,
      userId,
      content,
      images,
      sortOrder: maxOrder + 1,
      status: 'PENDING',
    };
    await this.repo.insert(item);
    return item;
  }

  async dequeue(sessionId: number): Promise<MessageQueue | null> {
    const head = await this.repo.findHeadPending(sessionId);
    if (head) {
      head.status = 'DELETED';
      await this.repo.updateById(head);
    }
    return head;
  }

  async delete(queueId: number): Promise<void> {
    const item = await this.repo.findById(queueId);
    if (item) {
      item.status = 'DELETED';
      await this.repo.updateById(item);
    }
  }

  async reorder(queueId: number, direction: string): Promise<void> {
    const current = await this.repo.findById(queueId);
    if (current == null || current.status !== 'PENDING' || current.sessionId == null || current.sortOrder == null) {
      return;
    }
    const neighbor = direction === 'up'
      ? await this.repo.findNeighborUp(current.sessionId, current.sortOrder)
      : await this.repo.findNeighborDown(current.sessionId, current.sortOrder);
    if (neighbor != null && neighbor.sortOrder != null) {
      const tempOrder = current.sortOrder;
      current.sortOrder = neighbor.sortOrder;
      neighbor.sortOrder = tempOrder;
      await this.repo.updateById(current);
      await this.repo.updateById(neighbor);
    }
  }

  listPending(sessionId: number): Promise<MessageQueue[]> {
    return this.repo.listPending(sessionId);
  }

  getById(queueId: number): Promise<MessageQueue | null> {
    return this.repo.findById(queueId);
  }

  clear(sessionId: number): Promise<void> {
    return this.repo.clearPending(sessionId);
  }
}
