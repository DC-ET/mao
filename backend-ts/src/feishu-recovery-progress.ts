import * as Lark from '@larksuiteoapi/node-sdk';
import type { FeishuCardProgress } from './feishu/card-progress-listener.js';
import type { MysqlFeishuProgressCardRepository } from './feishu/progress-card.repository.js';
import type { SessionService } from './session/session.service.js';
import { parseSqlTimeMs } from './app-utils.js';

export interface FeishuRecoveryProgressDeps {
  getFeishuClient: (botId: number) => Promise<Lark.Client | null>;
  feishuProgressCardRepo: MysqlFeishuProgressCardRepository;
  sessionService: SessionService;
  resolveFeishuSessionDetailUrl: (sessionId: number) => Promise<string | undefined>;
  resolveFeishuRoundOffset: (sessionId: number) => Promise<number>;
  createPatchedProgress: (
    client: Lark.Client,
    cardMessageId: string,
    sessionId: number,
    cancelAction: { sessionId: number; sender: string; botId?: number } | null,
    startedAtMs: number,
    sessionDetailUrl?: string,
    seed?: { round?: number; content?: string },
    botId?: number,
  ) => FeishuCardProgress;
}

export function createFeishuRecoveryProgressHelper(deps: FeishuRecoveryProgressDeps) {
  const { getFeishuClient, feishuProgressCardRepo, sessionService, resolveFeishuSessionDetailUrl, resolveFeishuRoundOffset, createPatchedProgress } = deps;

  return async (sessionId: number): Promise<{ progress: FeishuCardProgress; roundOffset: number } | null> => {
    try {
      const row = await feishuProgressCardRepo.findBySessionId(sessionId);
      if (row == null) {
        console.warn(`飞书恢复进度卡片无映射, sessionId=${sessionId}`);
        return null;
      }
      const client = await getFeishuClient(row.botId);
      if (client == null) {
        console.warn(`飞书恢复进度卡片无法创建客户端, sessionId=${sessionId} botId=${row.botId}`);
        return null;
      }
      const cancelAction = row.senderOpenId != null && row.senderOpenId !== ''
        ? { sessionId, sender: row.senderOpenId, botId: row.botId }
        : null;
      const sessionDetailUrl = await resolveFeishuSessionDetailUrl(sessionId);
      const session = await sessionService.getSession(sessionId).catch(() => null);
      const startedAtMs = parseSqlTimeMs(session?.startedAt) ?? Date.now();
      const progress = createPatchedProgress(client, row.cardMessageId, sessionId, cancelAction, startedAtMs, sessionDetailUrl, {
        content: '任务正在恢复执行。',
      }, row.botId);
      const roundOffset = await resolveFeishuRoundOffset(sessionId);
      try {
        await progress.update('RUNNING', roundOffset, '任务正在恢复执行。', []);
      } catch (error) {
        console.warn(`飞书恢复进度卡片首次 PATCH 失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { progress, roundOffset };
    } catch (error) {
      console.warn(`飞书恢复进度卡片加载失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
}
