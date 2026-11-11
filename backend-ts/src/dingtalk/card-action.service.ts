import { cardCallbackResponse, progressCardParams, queueCardParams } from './card-body.js';
import { parseCardCallback } from './card-callback.js';
import type { DingtalkCardActionPort, DingtalkInboundQueueRow } from './types.js';
import type { DingtalkProgressCardRow } from './progress-card.repository.js';

const SENDER_ONLY = '仅消息发送者可操作';

function previewOf(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as { context?: { text?: string } };
    return parsed.context?.text ?? '';
  } catch {
    return '';
  }
}

export interface DingtalkCardDecision {
  response: Record<string, unknown>;
  after?: () => Promise<void>;
}

/**
 * 卡片回调只改状态并返回新变量。取消 / 重试 / 插队的重活放在 after，由调用方在回包之后执行。
 * 回调过程中不调用「更新卡片」接口。
 */
export class DingtalkCardActionService {
  constructor(private readonly options: {
    queuePort: DingtalkCardActionPort;
    findProgress: (outTrackId: string) => Promise<DingtalkProgressCardRow | null>;
    interruptAndDrain: (sessionId: number) => void;
    cancelRunning: (sessionId: number) => Promise<boolean>;
    retryFailed?: (sessionId: number) => Promise<{ ok: true } | { ok: false; reason: 'BUSY' | 'NOT_FAILED' | 'NO_PROGRESS' }>;
    getPhase?: (sessionId: number) => Promise<string | null>;
    sessionDetailUrl?: (sessionId: number) => Promise<string | undefined>;
  }) {}

  async decide(raw: unknown): Promise<DingtalkCardDecision | undefined> {
    const event = parseCardCallback(raw);
    if (event == null) return undefined;
    if (event.actionId === 'run' || event.actionId === 'cancel') {
      // 一卡到底后，升级卡在执行期间共用队列行 outTrackId：行进入 RUNNING 后该回调属于
      // 进度卡（取消任务 / 重试），必须落到 findProgress 分支——队列表分支只管真正的排队态，
      // 否则 RUNNING 行会被 decideQueue 的 ALREADY_STARTED 挡掉，执行期间的「取消任务」永远失败。
      const row = await this.options.queuePort.findByOutTrackId(event.outTrackId);
      if (row != null && row.status === 'QUEUED') return this.decideQueue(event.userId, event.actionId, row);
    }
    if (event.actionId === 'retry' || event.actionId === 'cancel') {
      const progress = await this.options.findProgress(event.outTrackId);
      if (progress != null) return this.decideProgress(event.userId, event.actionId, event.params, progress);
    }
    return undefined;
  }

  private async decideQueue(userId: string, actionId: string, row: DingtalkInboundQueueRow): Promise<DingtalkCardDecision> {
    if (userId !== row.senderUserid) return { response: cardCallbackResponse(null, SENDER_ONLY) };
    const preview = previewOf(row.payload);
    if (actionId === 'cancel') {
      const result = await this.options.queuePort.cancel(row.id);
      if (result !== 'CANCELLED') return { response: cardCallbackResponse(null, '该排队消息已开始或已失效') };
      return { response: cardCallbackResponse(queueCardParams({ status: 'cancelled', preview, queueId: row.id, senderUserid: row.senderUserid })) };
    }
    const jumped = await this.options.queuePort.jumpToFront(row.id);
    // 以插队结果为准。查找时的 QUEUED 快照可能已经过期，不能在 jump 失败后仍宣告 started 并打断会话。
    if (!jumped) return { response: cardCallbackResponse(null, '该排队消息已开始或已失效') };
    return {
      response: cardCallbackResponse(queueCardParams({ status: 'started', preview, queueId: row.id, senderUserid: row.senderUserid })),
      after: async () => { this.options.interruptAndDrain(row.sessionId); },
    };
  }

  private async decideProgress(
    userId: string,
    actionId: string,
    params: Record<string, string>,
    progress: DingtalkProgressCardRow,
  ): Promise<DingtalkCardDecision> {
    const sender = params.senderUserid || progress.senderUserid || '';
    if (sender === '' || userId !== sender) return { response: cardCallbackResponse(null, SENDER_ONLY) };
    const sessionUrl = await this.options.sessionDetailUrl?.(progress.sessionId).catch(() => undefined);
    if (actionId === 'retry') {
      const retry = this.options.retryFailed;
      if (retry == null) return { response: cardCallbackResponse(null, '重试功能不可用') };
      const phase = this.options.getPhase == null ? null : await this.options.getPhase(progress.sessionId).catch(() => null);
      if (phase === 'RUNNING' || phase === 'RESUMING') return { response: cardCallbackResponse(null, '任务正在执行中') };
      if (phase != null && phase !== 'FAILED') return { response: cardCallbackResponse(null, '任务已结束，无法重试') };
      return {
        response: cardCallbackResponse(progressCardParams({
          status: 'running', round: 0, detail: '正在重试，请稍候…', sessionUrl, sessionId: progress.sessionId, senderUserid: sender,
        })),
        after: async () => { await retry(progress.sessionId); },
      };
    }
    if (actionId !== 'cancel') {
      // 排队态专用回调（run）落到进度卡：按钮此刻必已隐藏（canRun=false），陈旧点击不动作。
      return { response: cardCallbackResponse(null, '该操作已失效') };
    }
    const cancelled = await this.options.cancelRunning(progress.sessionId);
    if (!cancelled) return { response: cardCallbackResponse(null, '该任务已结束') };
    return {
      response: cardCallbackResponse(progressCardParams({
        status: 'cancelled', round: 0, detail: '任务已取消。', sessionUrl, sessionId: progress.sessionId, senderUserid: sender,
      })),
    };
  }
}
