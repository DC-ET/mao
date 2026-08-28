import type { FeishuCardActionEvent, FeishuCardActionPort, FeishuCardActionResponse, FeishuCardActionValue, FeishuProgressCardActionValue } from './types.js';

/** 排队卡片终态/中间态 PATCH 内容构建（无按钮）。 */
function buildQueueCardText(bold: string, body: string): Record<string, unknown> {
  return {
    schema: '2.0',
    config: { update_multi: true },
    body: {
      direction: 'vertical', padding: '12px 12px 12px 12px',
      elements: [
        { tag: 'markdown', content: `**${bold}**`, text_align: 'left', text_size: 'normal_v2' },
        { tag: 'markdown', content: body, text_align: 'left', text_size: 'normal_v2' },
      ],
    },
  };
}

/**
 * 飞书卡片按钮回调处理器：解析 card.action.trigger 事件，分派「立即发送」与「取消本次任务」。
 * 按钮仅原发送者可操作（open_id 比对）；操作结果通过 PATCH 卡片呈现，无效操作返回 toast。
 */
export class FeishuCardActionService {
  constructor(private readonly options: {
    queuePort: FeishuCardActionPort;
    /** 中断当前会话执行（设置取消标志 + 关闭 shell）。 */
    interrupt: (sessionId: number) => void;
    /** 取消会话当前执行中的任务（进度卡「取消任务」按钮）；返回 false 表示当前无在执行任务。 */
    cancelRunning: (sessionId: number) => boolean;
    /** PATCH 卡片内容（botId 用于定位客户端）。 */
    patchCard: (botId: number, cardMessageId: string, card: Record<string, unknown>) => Promise<void>;
  }) {}

  async handle(raw: unknown, _accountId: string): Promise<FeishuCardActionResponse | undefined> {
    const event = raw as FeishuCardActionEvent;
    const action = this.parseActionValue(event.action?.value);
    if (action == null) return undefined;
    if (action.kind === 'feishu_progress') return this.handleProgressCancel(event, action);
    const cardMessageId = event.context?.open_message_id ?? event.open_message_id;
    if (cardMessageId == null) return undefined;
    const row = await this.options.queuePort.findByCardMessageId(cardMessageId);
    if (row == null) return { toast: { type: 'info', content: '消息已失效，请重新发送' } };
    // 交叉核对按钮携带的 queueId 与行 id，避免卡片归属不一致时误操作。
    if (row.id !== action.queueId) return { toast: { type: 'info', content: '消息已失效，请重新发送' } };
    const operatorOpenId = event.operator?.open_id;
    if (operatorOpenId == null || operatorOpenId !== row.senderOpenId) {
      return { toast: { type: 'error', content: '仅消息发送者可操作' } };
    }
    if (action.act === 'run') return this.handleRun(row);
    if (action.act === 'cancel') return this.handleCancel(row);
    return undefined;
  }

  /** 进度卡「取消任务」：点击者须为触发任务的原发送者；取消成功后卡片由执行收尾链路 PATCH 为已取消终态。 */
  private handleProgressCancel(event: FeishuCardActionEvent, action: FeishuProgressCardActionValue): FeishuCardActionResponse | undefined {
    const operatorOpenId = event.operator?.open_id;
    if (operatorOpenId == null || operatorOpenId !== action.sender) {
      return { toast: { type: 'error', content: '仅消息发送者可操作' } };
    }
    if (!this.options.cancelRunning(action.sessionId)) {
      return { toast: { type: 'info', content: '该任务已结束' } };
    }
    return undefined;
  }

  private async handleRun(row: { id: number; sessionId: number; status: string; cardMessageId: string | null; botId: number }): Promise<FeishuCardActionResponse | undefined> {
    if (row.status === 'RUNNING') return { toast: { type: 'info', content: '该消息已开始执行' } };
    if (row.status !== 'QUEUED') return { toast: { type: 'info', content: '该消息已失效' } };
    const jumped = await this.options.queuePort.jumpToFront(row.id);
    if (!jumped) return { toast: { type: 'info', content: '该消息已开始执行' } };
    if (row.cardMessageId != null) {
      try {
        await this.options.patchCard(row.botId, row.cardMessageId, buildQueueCardText('🚀 已插队', '正在中断当前任务并执行这条消息…'));
      } catch (error) {
        console.warn(`飞书排队卡片插队 PATCH 失败, cardMessageId=${row.cardMessageId}`, error);
      }
    }
    this.options.interrupt(row.sessionId);
    return undefined;
  }

  private async handleCancel(row: { id: number; cardMessageId: string | null; botId: number }): Promise<FeishuCardActionResponse | undefined> {
    const result = await this.options.queuePort.cancel(row.id);
    if (result === 'ALREADY_STARTED') return { toast: { type: 'info', content: '该消息已开始执行' } };
    if (result === 'NOT_FOUND') return { toast: { type: 'info', content: '该消息已失效' } };
    if (row.cardMessageId != null) {
      try {
        await this.options.patchCard(row.botId, row.cardMessageId, buildQueueCardText('✖️ 已取消', '这条消息已取消，未进入执行。'));
      } catch (error) {
        console.warn(`飞书排队卡片取消 PATCH 失败, cardMessageId=${row.cardMessageId}`, error);
      }
    }
    return undefined;
  }

  private parseActionValue(value: unknown): FeishuCardActionValue | null {
    if (value == null) return null;
    let obj: Record<string, unknown>;
    if (typeof value === 'string') {
      // 飞书回调中 value 可能是 JSON 字符串（SDK 存在 string/object 双形态），需兼容解析。
      try {
        const parsed = JSON.parse(value) as unknown;
        if (parsed == null || typeof parsed !== 'object') return null;
        obj = parsed as Record<string, unknown>;
      } catch {
        return null;
      }
    } else if (typeof value === 'object') {
      obj = value as Record<string, unknown>;
    } else {
      return null;
    }
    if (obj.kind === 'feishu_progress') {
      const sessionId = Number(obj.sessionId);
      const sender = obj.sender;
      if (!Number.isFinite(sessionId) || typeof sender !== 'string' || sender === '') return null;
      if (obj.act !== 'cancel') return null;
      return { kind: 'feishu_progress', act: 'cancel', sessionId, sender };
    }
    if (obj.kind !== 'feishu_queue') return null;
    const queueId = Number(obj.queueId);
    if (!Number.isFinite(queueId)) return null;
    const act = obj.act;
    if (act !== 'run' && act !== 'cancel') return null;
    return { kind: 'feishu_queue', queueId, act };
  }
}
