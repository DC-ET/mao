import type { MessageQueue } from './types.js';
import type { MessageQueueRepository } from './message-queue.repository.js';
export class MessageQueueService {
  constructor(private readonly repo: MessageQueueRepository) {}

  async enqueue(sessionId: number, userId: number, content: string, images: string | null): Promise<MessageQueue> {
    // 事务 + FOR UPDATE 锁住队尾，避免并发 enqueue 读到相同 max(sort_order) 产生重复排序值
    return this.repo.transaction(async (tx) => {
      const last = await tx.findLastPendingForUpdate(sessionId);
      const maxOrder = last?.sortOrder ?? 0;
      const item: MessageQueue = {
        sessionId,
        userId,
        content,
        images,
        sortOrder: maxOrder + 1,
        status: 'PENDING',
      };
      await tx.insert(item);
      return item;
    });
  }

  /** 将消息插回队头（用于 auto-consume 失败补偿），取队首 order-1 保证排在所有现存消息之前。 */
  async enqueueHead(sessionId: number, userId: number, content: string, images: string | null): Promise<void> {
    return this.repo.transaction(async (tx) => {
      const first = await tx.findFirstPendingForUpdate(sessionId);
      const minOrder = first?.sortOrder ?? 1;
      await tx.insert({
        sessionId,
        userId,
        content,
        images,
        sortOrder: minOrder - 1,
        status: 'PENDING',
      });
    });
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
