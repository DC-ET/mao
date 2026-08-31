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
    for (let attempt = 0; ; attempt++) {
      try {
        await this.reorderOnce(queueId, direction);
        return;
      } catch (e) {
        // 相反方向并发操作同一对相邻行时锁序相反，可能触发 InnoDB 死锁；
        // 死锁由 InnoDB 即时检测并回滚一侧，基于最新状态有限重试，避免 WS 层表现为静默失败。
        // 锁等待超时不重试：等待本身已耗时 innodb_lock_wait_timeout，立即重试会进一步挂起请求。
        if (attempt < 2 && isLockConflictError(e)) continue;
        throw e;
      }
    }
  }

  private async reorderOnce(queueId: number, direction: string): Promise<void> {
    // 事务 + FOR UPDATE 锁定 current 与 neighbor（同 enqueue 的队尾锁策略），
    // 防止并发 reorder 读到相同快照导致交换丢失或重复 sort_order。
    await this.repo.transaction(async (tx) => {
      const current = await tx.findByIdForUpdate(queueId);
      if (current == null || current.status !== 'PENDING' || current.sessionId == null || current.sortOrder == null) {
        return;
      }
      const neighbor = direction === 'up'
        ? await tx.findNeighborUpForUpdate(current.sessionId, current.sortOrder)
        : await tx.findNeighborDownForUpdate(current.sessionId, current.sortOrder);
      if (neighbor != null && neighbor.sortOrder != null) {
        const tempOrder = current.sortOrder;
        current.sortOrder = neighbor.sortOrder;
        neighbor.sortOrder = tempOrder;
        await tx.updateById(current);
        await tx.updateById(neighbor);
      }
    });
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

/** MySQL 死锁错误码：InnoDB 即时检测并自动回滚一侧，可基于最新状态立即重试。 */
function isLockConflictError(e: unknown): boolean {
  if (typeof e !== 'object' || e == null || !('code' in e)) {
    return false;
  }
  return (e as { code?: unknown }).code === 'ER_LOCK_DEADLOCK';
}
