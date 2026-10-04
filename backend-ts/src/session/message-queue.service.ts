import type { MessageQueue } from './types.js';
import type { MessageQueueRepository } from './message-queue.repository.js';
export class MessageQueueService {
  constructor(private readonly repo: MessageQueueRepository) {}

  async enqueue(
    sessionId: number,
    userId: number,
    content: string,
    images: string | null,
    scheduledTaskId?: number | null,
  ): Promise<MessageQueue> {
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
        scheduledTaskId: scheduledTaskId ?? null,
      };
      await tx.insert(item);
      return item;
    });
  }

  /** 将消息插回队头（用于 auto-consume 失败补偿），取队首 order-1 保证排在所有现存消息之前。 */
  async enqueueHead(
    sessionId: number,
    userId: number,
    content: string,
    images: string | null,
    scheduledTaskId?: number | null,
  ): Promise<void> {
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
        scheduledTaskId: scheduledTaskId ?? null,
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

  /** 将消息移动到目标下标（0 = 队首），越界下标收敛到边界，队列规模小可全量重排。 */
  async moveToIndex(queueId: number, targetIndex: number): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.moveToIndexOnce(queueId, targetIndex);
        return;
      } catch (e) {
        // 并发移动/入队与全量行锁交叉时可能触发 InnoDB 死锁；
        // 死锁由 InnoDB 即时检测并回滚一侧，基于最新状态有限重试，避免 WS 层表现为静默失败。
        // 锁等待超时不重试：等待本身已耗时 innodb_lock_wait_timeout，立即重试会进一步挂起请求。
        if (attempt < 2 && isLockConflictError(e)) continue;
        throw e;
      }
    }
  }

  private async moveToIndexOnce(queueId: number, targetIndex: number): Promise<void> {
    // 事务内用单条 SELECT ... FOR UPDATE 锁定会话全部 pending 行：移动会区间改写多行
    // sort_order，仅锁两行挡不住并发 enqueue/reorder 产生重复排序值；固定排序加锁也
    // 让并发 moveToIndex 之间不再死锁。队列长度为用户可见量级，全量锁定开销可忽略。
    await this.repo.transaction(async (tx) => {
      const located = await tx.findById(queueId);
      if (located == null || located.sessionId == null) {
        return;
      }
      const items = await tx.listPendingForUpdate(located.sessionId);
      const from = items.findIndex((item) => item.id === queueId);
      // 不在 pending 集合内：已被消费或删除，静默忽略
      if (from < 0) {
        return;
      }
      const to = Math.max(0, Math.min(items.length - 1, targetIndex));
      if (from === to) {
        return;
      }
      const [moved] = items.splice(from, 1);
      items.splice(to, 0, moved);
      for (let i = 0; i < items.length; i++) {
        if (items[i].sortOrder !== i + 1) {
          items[i].sortOrder = i + 1;
          await tx.updateById(items[i]);
        }
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
