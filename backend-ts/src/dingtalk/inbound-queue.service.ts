import type { DingtalkCardActionPort, DingtalkInboundQueueRow, DingtalkTaskQueuePort } from './types.js';
import type { DingtalkInboundQueueRepository } from './inbound-queue.repository.js';

export class DingtalkTaskQueueService implements DingtalkTaskQueuePort, DingtalkCardActionPort {
  constructor(private readonly repo: DingtalkInboundQueueRepository) {}

  async enqueue(params: {
    sessionId: number;
    botId: number;
    messageId: string;
    senderUserid: string;
    maoUserId: number | null;
    payload: string;
  }): Promise<number> {
    try {
      return await this.repo.transaction(async (tx) => {
        const maxRank = await tx.findMaxRankForUpdate(params.sessionId);
        const existing = await tx.findByBotAndMessage(params.botId, params.messageId);
        if (existing != null) return existing.id;
        return tx.insert({
          botId: params.botId,
          sessionId: params.sessionId,
          messageId: params.messageId,
          outTrackId: null,
          senderUserid: params.senderUserid,
          maoUserId: params.maoUserId,
          rankNo: maxRank + 1,
          status: 'QUEUED',
          payload: params.payload,
        });
      });
    } catch (error) {
      console.warn(`钉钉消息入队冲突，回退查找已有行, botId=${params.botId}, messageId=${params.messageId}`, error);
      const existing = await this.repo.findByBotAndMessage(params.botId, params.messageId);
      if (existing != null) return existing.id;
      throw error;
    }
  }

  setOutTrackId(id: number, outTrackId: string): Promise<void> {
    return this.repo.setOutTrackId(id, outTrackId);
  }

  claimNext(sessionId: number): Promise<DingtalkInboundQueueRow | null> {
    return this.repo.claimNextQueued(sessionId);
  }

  async complete(id: number): Promise<void> {
    await this.repo.deleteById(id);
  }

  hasPending(sessionId: number): Promise<boolean> {
    return this.repo.countPending(sessionId).then((n) => n > 0);
  }

  findByOutTrackId(outTrackId: string): Promise<DingtalkInboundQueueRow | null> {
    return this.repo.findByOutTrackId(outTrackId);
  }

  findById(id: number): Promise<DingtalkInboundQueueRow | null> {
    return this.repo.findById(id);
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

  async hydrate(): Promise<number[]> {
    const running = await this.repo.listRunning();
    for (const row of running) {
      const persisted = await this.repo.findPersistedMessageByQueueId(row.sessionId, row.id);
      if (persisted != null) await this.repo.deleteById(row.id);
      else await this.repo.resetRunningToQueued(row.id);
    }
    await this.repo.deleteTerminal();
    const rows = await this.repo.listRecoverable();
    return [...new Set(rows.map((r) => r.sessionId))];
  }
}
