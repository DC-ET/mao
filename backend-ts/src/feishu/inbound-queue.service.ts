import type { FeishuInboundQueueRow, FeishuTaskQueuePort, FeishuCardActionPort } from './types.js';
import type { FeishuInboundQueueRepository } from './inbound-queue.repository.js';

/**
 * 飞书入站任务队列服务：FIFO 排队 + CAS 认领 + 跳队首 + 取消 + 启动恢复。
 * 实现 FeishuTaskQueuePort（handler 消费）与 FeishuCardActionPort（卡片按钮回调）两个端口。
 */
export class FeishuTaskQueueService implements FeishuTaskQueuePort, FeishuCardActionPort {
  constructor(private readonly repo: FeishuInboundQueueRepository) {}

  async enqueue(params: {
    sessionId: number;
    botId: number;
    messageId: string;
    senderOpenId: string;
    maoUserId: number | null;
    payload: string;
  }): Promise<number> {
    try {
      return await this.repo.transaction(async (tx) => {
        const maxRank = await tx.findMaxRankForUpdate(params.sessionId);
        const existing = await tx.findByBotAndMessage(params.botId, params.messageId);
        if (existing != null) return existing.id;
        const id = await tx.insert({
          botId: params.botId,
          sessionId: params.sessionId,
          messageId: params.messageId,
          cardMessageId: null,
          senderOpenId: params.senderOpenId,
          maoUserId: params.maoUserId,
          rankNo: maxRank + 1,
          status: 'QUEUED',
          payload: params.payload,
        });
        return id;
      });
    } catch (error) {
      // 唯一键冲突等并发重复入队（事件重投 / 双实例竞争）：查询已有行，视为已入队（幂等）。
      console.warn(`飞书消息入队冲突，回退查找已有行, botId=${params.botId}, messageId=${params.messageId}`, error);
      const existing = await this.repo.findByBotAndMessage(params.botId, params.messageId);
      if (existing != null) return existing.id;
      throw error;
    }
  }

  async setCardMessageId(id: number, cardMessageId: string): Promise<void> {
    await this.repo.setCardMessageId(id, cardMessageId);
  }

  claimNext(sessionId: number): Promise<FeishuInboundQueueRow | null> {
    return this.repo.claimNextQueued(sessionId);
  }

  async complete(id: number): Promise<void> {
    await this.repo.deleteById(id);
  }

  hasPending(sessionId: number): Promise<boolean> {
    return this.repo.countPending(sessionId).then((n) => n > 0);
  }

  findByCardMessageId(cardMessageId: string): Promise<FeishuInboundQueueRow | null> {
    return this.repo.findByCardMessageId(cardMessageId);
  }

  jumpToFront(id: number): Promise<boolean> {
    return this.repo.jumpToFront(id);
  }

  async cancel(id: number): Promise<'CANCELLED' | 'ALREADY_STARTED' | 'NOT_FOUND'> {
    const row = await this.repo.findById(id);
    if (row == null) return 'NOT_FOUND';
    if (row.status === 'RUNNING') return 'ALREADY_STARTED';
    if (row.status !== 'QUEUED') return 'NOT_FOUND';
    const ok = await this.repo.cancelQueued(id);
    if (!ok) return 'ALREADY_STARTED';
    await this.repo.deleteById(id);
    return 'CANCELLED';
  }

  /** 启动恢复：对每条 RUNNING 行按「消息是否已写入会话历史」分支——
   *  已落库 → 删除行（该消息由 CrashRecovery 从历史重放，删除避免恢复后再重复消费）；
   *  未落库 → 复位为 QUEUED（消息从未持久化，无法恢复，由队列重新消费，保证不丢）。
   *  再清理终态行，返回有待消费 QUEUED 行的 sessionId 集合。 */
  async hydrate(): Promise<number[]> {
    const running = await this.repo.listRunning();
    for (const row of running) {
      const persisted = await this.repo.findPersistedMessageByQueueId(row.sessionId, row.id);
      if (persisted != null) {
        await this.repo.deleteById(row.id);
      } else {
        await this.repo.resetRunningToQueued(row.id);
      }
    }
    await this.repo.deleteTerminal();
    const rows = await this.repo.listRecoverable();
    return [...new Set(rows.map((r) => r.sessionId))];
  }
}
