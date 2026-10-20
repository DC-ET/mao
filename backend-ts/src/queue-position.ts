import type { FeishuInboundQueueRepository } from './feishu/inbound-queue.repository.js';

export interface QueuePositionDeps {
  feishuInboundQueueRepo: FeishuInboundQueueRepository;
}

export function createQueuePositionHelper(deps: QueuePositionDeps) {
  const { feishuInboundQueueRepo } = deps;

  /** 排队卡片展示位置：入队完成后队列中的 QUEUED 行数（含本条，插入语义=队尾第 N 位）。 */
  return async (sessionId: number): Promise<number> => (await feishuInboundQueueRepo.countPending(sessionId));
}
