import type { FeishuCardActionEvent, FeishuCardActionPort, FeishuCardActionResponse, FeishuCardActionValue, FeishuProgressCardActionValue } from './types.js';
import { buildFeishuProgressCard } from './progress-card.js';

/** 排队卡片终态/中间态 PATCH 内容构建（可选「会话详情」跳转按钮）。 */
function buildQueueCardText(bold: string, body: string, sessionDetailUrl?: string): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [
    { tag: 'markdown', content: `**${bold}**`, text_align: 'left', text_size: 'normal_v2' },
    { tag: 'markdown', content: body, text_align: 'left', text_size: 'normal_v2' },
  ];
  const detailUrl = sessionDetailUrl?.trim();
  if (detailUrl != null && detailUrl !== '') {
    elements.push({
      tag: 'column_set', flex_mode: 'flow', background_style: 'default',
      columns: [{
        tag: 'column', width: 'auto', vertical_align: 'top',
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: '会话详情' },
          type: 'default',
          behaviors: [{
            type: 'open_url',
            default_url: detailUrl,
            pc_url: detailUrl,
            ios_url: detailUrl,
            android_url: detailUrl,
          }],
        }],
      }],
    });
  }
  return {
    schema: '2.0',
    config: { update_multi: true },
    body: { direction: 'vertical', padding: '12px 12px 12px 12px', elements },
  };
}

/** 将排队卡终态包进 card.action.trigger 回调响应，避免客户端还原点击前内容。 */
function toCardCallback(bold: string, body: string, toast?: FeishuCardActionResponse['toast']): FeishuCardActionResponse {
  return {
    ...(toast != null ? { toast } : {}),
    card: { type: 'raw', data: buildQueueCardText(bold, body) },
  };
}

/**
 * SDK EventDispatcher 会把 v2 信封的 header/event 展开到顶层；部分入口仍可能传入原始信封。
 * 两种形态都要能读到 action / operator / open_message_id，否则按钮点击会静默无效。
 */
function unwrapCardActionEvent(raw: unknown): FeishuCardActionEvent {
  if (raw == null || typeof raw !== 'object') return {};
  const root = raw as Record<string, unknown>;
  const nested = root.event;
  if (root.action == null && nested != null && typeof nested === 'object') {
    const inner = nested as Record<string, unknown>;
    return {
      context: (inner.context as FeishuCardActionEvent['context']) ?? (root.context as FeishuCardActionEvent['context']),
      open_message_id: (inner.open_message_id as string | undefined) ?? (root.open_message_id as string | undefined),
      open_chat_id: (inner.open_chat_id as string | undefined) ?? (root.open_chat_id as string | undefined),
      token: (inner.token as string | undefined) ?? (root.token as string | undefined),
      operator: (inner.operator as FeishuCardActionEvent['operator']) ?? (root.operator as FeishuCardActionEvent['operator']),
      action: inner.action as FeishuCardActionEvent['action'],
    };
  }
  return root as FeishuCardActionEvent;
}

/**
 * 飞书卡片按钮回调处理器：解析 card.action.trigger 事件，分派「立即发送」与「取消本次任务」。
 * 按钮仅原发送者可操作（open_id 比对）；有效操作必须在回调响应里带回新卡片（不能只 PATCH），
 * 否则飞书客户端会把 loading 还原为点击前的「排队中」。
 */
export class FeishuCardActionService {
  constructor(private readonly options: {
    queuePort: FeishuCardActionPort;
    /** 中断当前会话执行（设置取消标志 + 关闭 shell）。 */
    interrupt: (sessionId: number) => void;
    /** 中断后批量推进队列（含「中断未命中时兜底消费」与「命中后立即接力」）。 */
    interruptAndDrain?: (sessionId: number) => void;
    /** 取消会话当前执行中的任务（进度卡「取消任务」按钮）；返回 false 表示当前无在执行任务。 */
    cancelRunning: (sessionId: number) => boolean | Promise<boolean>;
    /**
     * 失败卡「重试」：基于会话历史续跑（不插入新用户消息），并 PATCH 原进度卡片。
     * cardMessageId 取自回调事件的 open_message_id（点击的那张失败卡）。
     */
    retryFailed?: (sessionId: number, cardMessageId: string) => Promise<
      | { ok: true }
      | { ok: false; reason: 'BUSY' | 'NOT_FAILED' | 'NO_PROGRESS' }
    >;
    /** PATCH 卡片内容（botId 用于定位客户端）。仅作群内其他人的补充推送，不得阻塞回调。 */
    patchCard: (botId: number, cardMessageId: string, card: Record<string, unknown>) => Promise<void>;
    /** 拼「会话详情」深链（已含 `/tasks/{id}`）；返回 undefined 时不渲染按钮。 */
    sessionDetailUrl?: (sessionId: number) => Promise<string | undefined> | string | undefined;
  }) {}

  async handle(raw: unknown, _accountId: string): Promise<FeishuCardActionResponse | undefined> {
    const event = unwrapCardActionEvent(raw);
    const action = this.parseActionValue(event.action?.value);
    if (action == null) return undefined;
    if (action.kind === 'feishu_progress') {
      if (action.act === 'retry') return this.handleProgressRetry(event, action);
      return this.handleProgressCancel(event, action);
    }
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

  /** 进度卡「取消任务」：点击者须为触发任务的原发送者；取消成功后回调带回终态卡片，避免客户端还原为「正在处理」。 */
  private async handleProgressCancel(event: FeishuCardActionEvent, action: FeishuProgressCardActionValue): Promise<FeishuCardActionResponse | undefined> {
    const operatorOpenId = event.operator?.open_id;
    if (operatorOpenId == null || operatorOpenId !== action.sender) {
      return { toast: { type: 'error', content: '仅消息发送者可操作' } };
    }
    const cancelled = await this.options.cancelRunning(action.sessionId);
    if (!cancelled) {
      return { toast: { type: 'info', content: '该任务已结束' } };
    }
    return {
      toast: { type: 'success', content: '正在取消任务' },
      card: { type: 'raw', data: buildQueueCardText('任务已取消', '已停止当前任务。', await this.resolveSessionDetailUrl(action.sessionId)) },
    };
  }

  /** 失败卡「重试」：鉴权同取消；成功后回调带回 RUNNING 卡，后续由 progress 闭包续更。 */
  private async handleProgressRetry(event: FeishuCardActionEvent, action: FeishuProgressCardActionValue): Promise<FeishuCardActionResponse | undefined> {
    const operatorOpenId = event.operator?.open_id;
    if (operatorOpenId == null || operatorOpenId !== action.sender) {
      return { toast: { type: 'error', content: '仅消息发送者可操作' } };
    }
    const cardMessageId = event.context?.open_message_id ?? event.open_message_id;
    if (cardMessageId == null) return undefined;
    const retryFailed = this.options.retryFailed;
    if (retryFailed == null) return { toast: { type: 'info', content: '重试功能不可用' } };
    const result = await retryFailed(action.sessionId, cardMessageId);
    if (!result.ok) {
      if (result.reason === 'BUSY') return { toast: { type: 'info', content: '任务正在执行中' } };
      if (result.reason === 'NOT_FAILED') return { toast: { type: 'info', content: '任务已结束，无法重试' } };
      return { toast: { type: 'info', content: '无法定位原进度卡片，请重新发送消息' } };
    }
    return {
      toast: { type: 'success', content: '已开始重试' },
      card: {
        type: 'raw',
        data: buildFeishuProgressCard(
          'RUNNING', 0, '正在重试，请稍候…', [],
          undefined, undefined, await this.resolveSessionDetailUrl(action.sessionId),
        ),
      },
    };
  }

  private async resolveSessionDetailUrl(sessionId: number): Promise<string | undefined> {
    const resolve = this.options.sessionDetailUrl;
    if (resolve == null) return undefined;
    try {
      const url = await resolve(sessionId);
      return url?.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  private async handleRun(row: { id: number; sessionId: number; status: string; cardMessageId: string | null; botId: number }): Promise<FeishuCardActionResponse | undefined> {
    if (row.status === 'RUNNING') return { toast: { type: 'info', content: '该消息已开始执行' } };
    if (row.status !== 'QUEUED') return { toast: { type: 'info', content: '该消息已失效' } };
    const jumped = await this.options.queuePort.jumpToFront(row.id);
    if (!jumped) return { toast: { type: 'info', content: '该消息已开始执行' } };
    // 先中断后排空：drain 为 fire-and-forget，不得 await PATCH。回调必须在 3s 内返回新卡片，
    // 空响应会让点击端把卡片还原为「排队中」，看起来像消息没发出去。
    const interruptAndDrain = this.options.interruptAndDrain;
    if (interruptAndDrain != null) {
      interruptAndDrain(row.sessionId);
    } else {
      this.options.interrupt(row.sessionId);
    }
    const card = buildQueueCardText('🚀 已插队', '正在中断当前任务并执行这条消息…');
    // 不在这里 PATCH：排队卡稍后会被 drain 就地升级为进度卡；若后台 PATCH「已插队」
    // 晚于进度卡升级，会把「正在处理」盖回插队文案。点击者靠回调 card 更新，群内其他人
    // 会在任务开始执行时看到进度卡。
    return {
      toast: { type: 'success', content: '已插队，正在中断当前任务并执行这条消息' },
      card: { type: 'raw', data: card },
    };
  }

  private async handleCancel(row: { id: number; cardMessageId: string | null; botId: number }): Promise<FeishuCardActionResponse | undefined> {
    const result = await this.options.queuePort.cancel(row.id);
    if (result === 'ALREADY_STARTED') return { toast: { type: 'info', content: '该消息已开始执行' } };
    if (result === 'NOT_FOUND') return { toast: { type: 'info', content: '该消息已失效' } };
    const card = buildQueueCardText('✖️ 已取消', '这条消息已取消，未进入执行。');
    this.patchInBackground(row, card);
    return toCardCallback('✖️ 已取消', '这条消息已取消，未进入执行。', {
      type: 'success',
      content: '这条排队消息已取消，不会进入执行。',
    });
  }

  /** 群内其他人看不到回调响应里的卡片，后台 PATCH 一次；失败只记日志，不阻塞也不改回调结果。 */
  private patchInBackground(row: { cardMessageId: string | null; botId: number }, card: Record<string, unknown>): void {
    if (row.cardMessageId == null) return;
    void this.options.patchCard(row.botId, row.cardMessageId, card).catch((error) => {
      console.warn(`飞书排队卡片 PATCH 失败, cardMessageId=${row.cardMessageId}`, error);
    });
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
      if (obj.act !== 'cancel' && obj.act !== 'retry') return null;
      return { kind: 'feishu_progress', act: obj.act, sessionId, sender };
    }
    if (obj.kind !== 'feishu_queue') return null;
    const queueId = Number(obj.queueId);
    if (!Number.isFinite(queueId)) return null;
    const act = obj.act;
    if (act !== 'run' && act !== 'cancel') return null;
    return { kind: 'feishu_queue', queueId, act };
  }
}
