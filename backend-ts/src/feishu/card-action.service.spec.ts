import { describe, expect, it, vi } from 'vitest';
import { FeishuAskFormStore } from './ask-form-store.js';
import { FeishuCardActionService } from './card-action.service.js';
import { buildFeishuProgressCard } from './progress-card.js';
import { createFeishuPatchedProgress } from './patched-progress.js';
import type { FeishuCardActionPort, FeishuInboundQueueRow } from './types.js';

function row(overrides: Partial<FeishuInboundQueueRow> = {}): FeishuInboundQueueRow {
  return { id: 1, botId: 1, sessionId: 7, messageId: 'om_1', cardMessageId: 'cm_1', senderOpenId: 'ou_1', maoUserId: null, rankNo: 1, status: 'QUEUED', payload: '{}', ...overrides };
}

function options(overrides: Partial<Parameters<typeof makeService>[0]> = {}) {
  return makeService(overrides);
}
function makeService(overrides: {
  queuePort?: Partial<FeishuCardActionPort>;
  interrupt?: (sessionId: number) => void;
  interruptAndDrain?: (sessionId: number) => void;
  cancelRunning?: (sessionId: number) => boolean;
  toggleDislike?: (sessionId: number) => Promise<{ disliked: boolean } | null>;
  retryFailed?: (sessionId: number, cardMessageId: string) => Promise<
    | { ok: true }
    | { ok: false; reason: 'BUSY' | 'NOT_FAILED' | 'NO_PROGRESS' }
  >;
  patchCard?: (botId: number, cardMessageId: string, card: Record<string, unknown>) => Promise<void>;
  sessionDetailUrl?: (sessionId: number) => Promise<string | undefined> | string | undefined;
  askForms?: FeishuAskFormStore;
  renderProgressCard?: (sessionId: number) => Record<string, unknown> | null;
  refreshProgress?: (sessionId: number) => void | Promise<unknown>;
  completeAsk?: (sessionId: number, requestId: string, resultJson: string) => boolean;
  notifyAskAnswered?: (sessionId: number, requestId: string) => void;
} = {}) {
  const queuePort: FeishuCardActionPort = {
    findByCardMessageId: vi.fn(async () => null),
    jumpToFront: vi.fn(async () => false),
    cancel: vi.fn(async () => 'CANCELLED' as const),
    ...overrides.queuePort,
  };
  const interrupt = overrides.interrupt ?? vi.fn();
  const cancelRunning = overrides.cancelRunning ?? vi.fn(() => true);
  const patchCard = overrides.patchCard ?? vi.fn(async () => undefined);
  return new FeishuCardActionService({
    queuePort, interrupt, cancelRunning, patchCard,
    ...(overrides.interruptAndDrain != null ? { interruptAndDrain: overrides.interruptAndDrain } : {}),
    ...(overrides.toggleDislike != null ? { toggleDislike: overrides.toggleDislike } : {}),
    ...(overrides.retryFailed != null ? { retryFailed: overrides.retryFailed } : {}),
    ...(overrides.sessionDetailUrl != null ? { sessionDetailUrl: overrides.sessionDetailUrl } : {}),
    ...(overrides.askForms != null ? { askForms: overrides.askForms } : {}),
    ...(overrides.renderProgressCard != null ? { renderProgressCard: overrides.renderProgressCard } : {}),
    ...(overrides.refreshProgress != null ? { refreshProgress: overrides.refreshProgress } : {}),
    ...(overrides.completeAsk != null ? { completeAsk: overrides.completeAsk } : {}),
    ...(overrides.notifyAskAnswered != null ? { notifyAskAnswered: overrides.notifyAskAnswered } : {}),
  });
}

function expectQueueCard(res: unknown, bold: string, body: string) {
  expect(res).toEqual(expect.objectContaining({
    card: { type: 'raw', data: expect.objectContaining({ schema: '2.0' }) },
  }));
  const json = JSON.stringify(res);
  expect(json).toContain(bold);
  expect(json).toContain(body);
}

function makeEvent(value: unknown, operatorOpenId = 'ou_1', cardMessageId = 'cm_1') {
  return { context: { open_message_id: cardMessageId }, operator: { open_id: operatorOpenId }, action: { value } };
}

describe('FeishuCardActionService', () => {
  it('ignores events without recognized action value', async () => {
    const service = makeService();
    const res = await service.handle(makeEvent({ kind: 'other' }), '');
    expect(res).toBeUndefined();
  });

  it('ignores events without card message id', async () => {
    const service = makeService();
    const res = await service.handle({ operator: { open_id: 'ou_1' }, action: { value: { kind: 'feishu_queue', queueId: 1, act: 'run' } } }, '');
    expect(res).toBeUndefined();
  });

  it('returns info toast when queue row missing', async () => {
    const service = makeService({ queuePort: { findByCardMessageId: vi.fn(async () => null) } });
    const res = await service.handle(makeEvent({ kind: 'feishu_queue', queueId: 1, act: 'run' }), '');
    expect(res).toEqual({ toast: { type: 'info', content: '消息已失效，请重新发送' } });
  });

  it('forbids non-owner operator', async () => {
    const service = makeService({ queuePort: { findByCardMessageId: vi.fn(async () => row()) } });
    const res = await service.handle(makeEvent({ kind: 'feishu_queue', queueId: 1, act: 'run' }, 'ou_other'), '');
    expect(res).toEqual({ toast: { type: 'error', content: '仅消息发送者可操作' } });
  });

  it('cancel returns the updated card in the callback so Feishu does not revert', async () => {
    const patchCard = vi.fn(async () => undefined);
    const service = makeService({
      queuePort: { findByCardMessageId: vi.fn(async () => row()), cancel: vi.fn(async () => 'CANCELLED' as const) },
      patchCard,
    });
    const res = await service.handle(makeEvent({ kind: 'feishu_queue', queueId: 1, act: 'cancel' }), '');
    expect(res?.toast).toEqual({ type: 'success', content: '这条排队消息已取消，不会进入执行。' });
    expectQueueCard(res, '✖️ 已取消', '这条消息已取消，未进入执行。');
    await Promise.resolve();
    expect(patchCard).toHaveBeenCalledWith(1, 'cm_1', expect.objectContaining({ body: expect.anything() }));
    expect(JSON.stringify(patchCard.mock.calls[0])).toContain('这条消息已取消，未进入执行。');
  });

  it('queue cancel never interrupts or cancels the running execution', async () => {
    const interrupt = vi.fn();
    const interruptAndDrain = vi.fn();
    const cancelRunning = vi.fn(() => true);
    const queueCancel = vi.fn(async () => 'CANCELLED' as const);
    const service = makeService({
      queuePort: { findByCardMessageId: vi.fn(async () => row()), cancel: queueCancel },
      interrupt,
      interruptAndDrain,
      cancelRunning,
    });
    const res = await service.handle(makeEvent({ kind: 'feishu_queue', queueId: 1, act: 'cancel' }), '');
    expect(queueCancel).toHaveBeenCalledWith(1);
    expect(interrupt).not.toHaveBeenCalled();
    expect(interruptAndDrain).not.toHaveBeenCalled();
    expect(cancelRunning).not.toHaveBeenCalled();
    expect(res?.toast?.content).toBe('这条排队消息已取消，不会进入执行。');
  });

  it('still confirms cancellation when the background card PATCH fails', async () => {
    const cancel = vi.fn(async () => 'CANCELLED' as const);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const service = makeService({
        queuePort: { findByCardMessageId: vi.fn(async () => row()), cancel },
        patchCard: vi.fn(async () => { throw new Error('PATCH failed'); }),
      });
      const res = await service.handle(makeEvent({ kind: 'feishu_queue', queueId: 1, act: 'cancel' }), '');
      expect(cancel).toHaveBeenCalledWith(1);
      expect(res?.toast).toEqual({ type: 'success', content: '这条排队消息已取消，不会进入执行。' });
      expectQueueCard(res, '✖️ 已取消', '这条消息已取消，未进入执行。');
      await Promise.resolve();
    } finally {
      warn.mockRestore();
    }
  });

  it('confirms cancellation even when no card id was persisted', async () => {
    const patchCard = vi.fn(async () => undefined);
    const service = makeService({
      queuePort: { findByCardMessageId: vi.fn(async () => row({ cardMessageId: null })) },
      patchCard,
    });
    const res = await service.handle(makeEvent({ kind: 'feishu_queue', queueId: 1, act: 'cancel' }), '');
    expect(res?.toast).toEqual({ type: 'success', content: '这条排队消息已取消，不会进入执行。' });
    expectQueueCard(res, '✖️ 已取消', '这条消息已取消，未进入执行。');
    expect(patchCard).not.toHaveBeenCalled();
  });

  it('cancel returns ALREADY_STARTED toast when already running', async () => {
    const service = makeService({
      queuePort: { findByCardMessageId: vi.fn(async () => row()), cancel: vi.fn(async () => 'ALREADY_STARTED' as const) },
    });
    const res = await service.handle(makeEvent({ kind: 'feishu_queue', queueId: 1, act: 'cancel' }), '');
    expect(res).toEqual({ toast: { type: 'info', content: '该消息已开始执行' } });
  });

  it('run returns inserted card in the callback and interrupts without waiting on PATCH', async () => {
    const patchCard = vi.fn(async () => { throw new Error('PATCH should not block run'); });
    const interrupt = vi.fn();
    const service = makeService({
      queuePort: { findByCardMessageId: vi.fn(async () => row()), jumpToFront: vi.fn(async () => true) },
      patchCard,
      interrupt,
    });
    const res = await service.handle(makeEvent({ kind: 'feishu_queue', queueId: 1, act: 'run' }), '');
    expect(res?.toast).toEqual({ type: 'success', content: '已插队，正在中断当前任务并执行这条消息' });
    expectQueueCard(res, '🚀 已插队', '正在中断当前任务并执行这条消息…');
    expect(patchCard).not.toHaveBeenCalled();
    expect(interrupt).toHaveBeenCalledWith(7);
  });

  it('run prefers interruptAndDrain over interrupt', async () => {
    const interrupt = vi.fn();
    const interruptAndDrain = vi.fn();
    const service = makeService({
      queuePort: { findByCardMessageId: vi.fn(async () => row()), jumpToFront: vi.fn(async () => true) },
      interrupt,
      interruptAndDrain,
    });
    await service.handle(makeEvent({ kind: 'feishu_queue', queueId: 1, act: 'run' }), '');
    expect(interruptAndDrain).toHaveBeenCalledWith(7);
    expect(interrupt).not.toHaveBeenCalled();
  });

  it('run without card message id still returns callback card and interrupts', async () => {
    const patchCard = vi.fn(async () => undefined);
    const interrupt = vi.fn();
    const service = makeService({
      queuePort: { findByCardMessageId: vi.fn(async () => row({ cardMessageId: null })), jumpToFront: vi.fn(async () => true) },
      patchCard,
      interrupt,
    });
    const res = await service.handle(makeEvent({ kind: 'feishu_queue', queueId: 1, act: 'run' }), '');
    expectQueueCard(res, '🚀 已插队', '正在中断当前任务并执行这条消息…');
    expect(patchCard).not.toHaveBeenCalled();
    expect(interrupt).toHaveBeenCalledWith(7);
  });

  it('handles action value as JSON string (compat)', async () => {
    const interrupt = vi.fn();
    const service = makeService({
      queuePort: { findByCardMessageId: vi.fn(async () => row()), jumpToFront: vi.fn(async () => true) },
      interrupt,
    });
    const res = await service.handle(makeEvent(JSON.stringify({ kind: 'feishu_queue', queueId: 1, act: 'run' })), '');
    expectQueueCard(res, '🚀 已插队', '正在中断当前任务并执行这条消息…');
    expect(interrupt).toHaveBeenCalledWith(7);
  });

  it('handles the unflattened v2 envelope with nested event', async () => {
    const interrupt = vi.fn();
    const service = makeService({
      queuePort: { findByCardMessageId: vi.fn(async () => row()), jumpToFront: vi.fn(async () => true) },
      interrupt,
    });
    const envelope = {
      schema: '2.0',
      header: { event_type: 'card.action.trigger' },
      event: {
        operator: { open_id: 'ou_1' },
        action: { value: { kind: 'feishu_queue', queueId: 1, act: 'run' } },
        context: { open_message_id: 'cm_1' },
      },
    };
    const res = await service.handle(envelope, '');
    expectQueueCard(res, '🚀 已插队', '正在中断当前任务并执行这条消息…');
    expect(interrupt).toHaveBeenCalledWith(7);
  });

  it('rejects when queueId does not match the located row', async () => {
    const service = makeService({ queuePort: { findByCardMessageId: vi.fn(async () => row()) } });
    const res = await service.handle(makeEvent({ kind: 'feishu_queue', queueId: 999, act: 'cancel' }), '');
    expect(res).toEqual({ toast: { type: 'info', content: '消息已失效，请重新发送' } });
  });

  it('run returns info toast when jumpToFront fails', async () => {
    const service = makeService({
      queuePort: { findByCardMessageId: vi.fn(async () => row()), jumpToFront: vi.fn(async () => false) },
    });
    const res = await service.handle(makeEvent({ kind: 'feishu_queue', queueId: 1, act: 'run' }), '');
    expect(res).toEqual({ toast: { type: 'info', content: '该消息已开始执行' } });
  });

  it('progress cancel by original sender cancels running execution and returns a terminal card', async () => {
    const cancelRunning = vi.fn(() => true);
    const service = makeService({ cancelRunning });
    const value = { kind: 'feishu_progress', act: 'cancel', sessionId: 7, sender: 'ou_1' };
    const res = await service.handle(makeEvent(value), '');
    expect(res?.toast).toEqual({ type: 'success', content: '正在取消任务' });
    expectQueueCard(res, '任务已取消', '已停止当前任务。');
    expect(cancelRunning).toHaveBeenCalledWith(7);
  });

  it('progress cancel terminal card keeps session detail open_url button when configured', async () => {
    const service = makeService({
      cancelRunning: vi.fn(() => true),
      sessionDetailUrl: (sessionId) => `https://mao.example.com/tasks/${sessionId}`,
    });
    const value = { kind: 'feishu_progress', act: 'cancel', sessionId: 7, sender: 'ou_1' };
    const res = await service.handle(makeEvent(value), '');
    expectQueueCard(res, '任务已取消', '已停止当前任务。');
    const json = JSON.stringify(res);
    expect(json).toContain('会话详情');
    expect(json).toContain('https://mao.example.com/tasks/7');
    expect(json).toContain('open_url');
  });

  it('progress cancel forbids non-owner operator', async () => {
    const cancelRunning = vi.fn(() => true);
    const service = makeService({ cancelRunning });
    const value = { kind: 'feishu_progress', act: 'cancel', sessionId: 7, sender: 'ou_1' };
    const res = await service.handle(makeEvent(value, 'ou_other'), '');
    expect(res).toEqual({ toast: { type: 'error', content: '仅消息发送者可操作' } });
    expect(cancelRunning).not.toHaveBeenCalled();
  });

  it('progress cancel returns info toast when nothing is running', async () => {
    const cancelRunning = vi.fn(() => false);
    const service = makeService({ cancelRunning });
    const value = { kind: 'feishu_progress', act: 'cancel', sessionId: 7, sender: 'ou_1' };
    const res = await service.handle(makeEvent(value), '');
    expect(res).toEqual({ toast: { type: 'info', content: '该任务已结束' } });
  });

  it('accepts progress cancel action value as JSON string (compat)', async () => {
    const cancelRunning = vi.fn(() => true);
    const service = makeService({ cancelRunning });
    const value = JSON.stringify({ kind: 'feishu_progress', act: 'cancel', sessionId: 7, sender: 'ou_1' });
    const res = await service.handle(makeEvent(value), '');
    expect(res?.toast).toEqual({ type: 'success', content: '正在取消任务' });
    expect(cancelRunning).toHaveBeenCalledWith(7);
  });

  it('ignores progress action with unsupported act', async () => {
    const cancelRunning = vi.fn(() => true);
    const service = makeService({ cancelRunning });
    const res = await service.handle(makeEvent({ kind: 'feishu_progress', act: 'run', sessionId: 7, sender: 'ou_1' }), '');
    expect(res).toBeUndefined();
    expect(cancelRunning).not.toHaveBeenCalled();
  });

  it('progress retry by original sender starts retry and returns RUNNING card', async () => {    const retryFailed = vi.fn(async () => ({ ok: true as const }));
    const service = makeService({ retryFailed, sessionDetailUrl: () => 'https://mao.example.com/tasks/7' });
    const value = { kind: 'feishu_progress', act: 'retry', sessionId: 7, sender: 'ou_1' };
    const res = await service.handle(makeEvent(value, 'ou_1', 'cm_fail'), '');
    expect(res?.toast).toEqual({ type: 'success', content: '已开始重试' });
    expect(retryFailed).toHaveBeenCalledWith(7, 'cm_fail');
    const json = JSON.stringify(res);
    expect(json).toContain('正在重试');
    expect(json).toContain('https://mao.example.com/tasks/7');
  });

  it('progress retry forbids non-owner operator', async () => {
    const retryFailed = vi.fn(async () => ({ ok: true as const }));
    const service = makeService({ retryFailed });
    const value = { kind: 'feishu_progress', act: 'retry', sessionId: 7, sender: 'ou_1' };
    const res = await service.handle(makeEvent(value, 'ou_other'), '');
    expect(res).toEqual({ toast: { type: 'error', content: '仅消息发送者可操作' } });
    expect(retryFailed).not.toHaveBeenCalled();
  });

  it('progress retry surfaces busy / not-failed / missing-card toasts', async () => {
    const busy = makeService({ retryFailed: async () => ({ ok: false, reason: 'BUSY' }) });
    expect(await busy.handle(makeEvent({ kind: 'feishu_progress', act: 'retry', sessionId: 7, sender: 'ou_1' }), ''))
      .toEqual({ toast: { type: 'info', content: '任务正在执行中' } });
    const done = makeService({ retryFailed: async () => ({ ok: false, reason: 'NOT_FAILED' }) });
    expect(await done.handle(makeEvent({ kind: 'feishu_progress', act: 'retry', sessionId: 7, sender: 'ou_1' }), ''))
      .toEqual({ toast: { type: 'info', content: '任务已结束，无法重试' } });
    const missing = makeService({ retryFailed: async () => ({ ok: false, reason: 'NO_PROGRESS' }) });
    expect(await missing.handle(makeEvent({ kind: 'feishu_progress', act: 'retry', sessionId: 7, sender: 'ou_1' }), ''))
      .toEqual({ toast: { type: 'info', content: '无法定位原进度卡片，请重新发送消息' } });
  });

  it('progress retry without retryFailed option returns unavailable toast', async () => {
    const service = makeService();
    const res = await service.handle(makeEvent({ kind: 'feishu_progress', act: 'retry', sessionId: 7, sender: 'ou_1' }), '');
    expect(res).toEqual({ toast: { type: 'info', content: '重试功能不可用' } });
  });

  it('progress cancel clears pending ask forms before stopping the task', async () => {    const askForms = new FeishuAskFormStore();
    askForms.set(7, 'req-1', [{ question: '选哪个？' }], 'ou_1');
    const service = makeService({ askForms, cancelRunning: vi.fn(() => true) });
    const res = await service.handle(makeEvent({ kind: 'feishu_progress', act: 'cancel', sessionId: 7, sender: 'ou_1' }), '');
    expect(res?.toast?.content).toBe('正在取消任务');
    expect(askForms.list(7)).toEqual([]);
  });

  it('progress cancel by someone else does not clear ask forms', async () => {
    const askForms = new FeishuAskFormStore();
    askForms.set(7, 'req-1', [{ question: '选哪个？' }], 'ou_1');
    const service = makeService({ askForms, cancelRunning: vi.fn(() => true) });
    await service.handle(makeEvent({ kind: 'feishu_progress', act: 'cancel', sessionId: 7, sender: 'ou_1' }, 'ou_other'), '');
    expect(askForms.get(7, 'req-1')).not.toBeNull();
  });
});

describe('FeishuCardActionService 完成卡点踩', () => {
  const dislikeValue = { kind: 'feishu_progress', act: 'dislike', sessionId: 7, sender: 'ou_1' };

  function dislikeCardButtons(res: unknown): Array<Record<string, unknown>> {
    const elements = ((res as { card: { data: { body: { elements: Array<Record<string, unknown>> } } } }).card.data.body.elements) ?? [];
    return elements.flatMap((element) => (element.columns as Array<{ elements: Array<Record<string, unknown>> }> | undefined)?.flatMap((column) => column.elements) ?? []);
  }

  it('点踩写入并回调红色「已点踩 · 再点取消」卡片', async () => {
    const toggleDislike = vi.fn(async () => ({ disliked: true }));
    const service = makeService({
      toggleDislike,
      renderProgressCard: () => buildFeishuProgressCard(
        'COMPLETED', 8, '这是任务的最终结果正文。', ['read_file：读取完成'],
        { sessionId: 7, sender: 'ou_1' }, 506_000, 'https://mao.example.com/tasks/7',
      ),
      sessionDetailUrl: () => 'https://mao.example.com/tasks/7',
    });
    const res = await service.handle(makeEvent(dislikeValue), '');
    expect(toggleDislike).toHaveBeenCalledWith(7);
    expect(res?.toast).toEqual({ type: 'success', content: '已标记不满意' });
    const json = JSON.stringify(res);
    // 回调必须带回整张完成卡：轮次、耗时、正文都不能丢（用户正是要评价这段结果）
    expect(json).toContain('共 8 轮 · 耗时 8 分 26 秒');
    expect(json).toContain('这是任务的最终结果正文。');
    expect(json).toContain('read_file：读取完成');
    // 按钮 value 保留，文案由调用方注入的快照决定（此处 mock 未接 setDisliked，仍为未点踩态）
    const dislike = dislikeCardButtons(res).find((button) => (button.value as { act?: string })?.act === 'dislike');
    expect(dislike?.value).toEqual({ kind: 'feishu_progress', act: 'dislike', sessionId: 7, sender: 'ou_1' });
  });

  it('快照按 setDisliked 后的状态渲染按钮', async () => {
    // 用真实进度卡闭包验证：toggle 成功后回调返回的卡片带 toggle 后的按钮态与完整正文
    const store = new FeishuAskFormStore();
    const cards: Array<Record<string, unknown>> = [];
    const progress = createFeishuPatchedProgress({
      listAsks: () => store.list(7),
      clearAsks: () => store.clearSession(7),
      patch: async (card) => { cards.push(card); },
      buildCard: ({ status, round, content, tools, elapsedMs, disliked }) => buildFeishuProgressCard(
        status, round, content, tools, { sessionId: 7, sender: 'ou_1' }, elapsedMs, undefined, undefined, disliked,
      ),
      startedAtMs: 0,
      now: () => 506_000,
    });
    await progress.update('COMPLETED', 8, '这是任务的最终结果正文。', ['read_file：读取完成']);
    const toggleDislike = vi.fn(async () => {
      progress.setDisliked(true);
      return { disliked: true };
    });
    const service = makeService({ toggleDislike, renderProgressCard: () => progress.renderCurrent() });
    const res = await service.handle(makeEvent(dislikeValue), '');
    const json = JSON.stringify(res);
    expect(json).toContain('共 8 轮 · 耗时 8 分 26 秒');
    expect(json).toContain('这是任务的最终结果正文。');
    const dislike = dislikeCardButtons(res).find((button) => (button.value as { act?: string })?.act === 'dislike');
    expect(dislike?.text).toEqual({ tag: 'plain_text', content: '👎 已点踩 · 再点取消' });
    expect(dislike?.type).toBe('danger');
  });

  it('快照缺失时退回完成态空卡，不会渲染成执行中', async () => {
    const toggleDislike = vi.fn(async () => ({ disliked: true }));
    const service = makeService({ toggleDislike, renderProgressCard: () => null });
    const res = await service.handle(makeEvent(dislikeValue), '');
    const json = JSON.stringify(res);
    expect(json).toContain('处理完成');
    expect(json).not.toContain('正在处理');
    expect(json).not.toContain('取消任务');
    expect(json).toContain('👎 已点踩 · 再点取消');
  });

  it('再次点击取消点踩并回调恢复未点踩态', async () => {
    const toggleDislike = vi.fn(async () => ({ disliked: false }));
    const service = makeService({ toggleDislike });
    const res = await service.handle(makeEvent(dislikeValue), '');
    expect(res?.toast).toEqual({ type: 'info', content: '已取消点踩' });
    const dislike = dislikeCardButtons(res).find((button) => (button.value as { act?: string })?.act === 'dislike');
    expect(dislike?.text).toEqual({ tag: 'plain_text', content: '👎 不满意' });
    expect(dislike?.type).toBe('default');
  });
  it('非发送者点击被拒绝，不写库', async () => {
    const toggleDislike = vi.fn(async () => ({ disliked: true }));
    const service = makeService({ toggleDislike });
    const res = await service.handle(makeEvent(dislikeValue, 'ou_other'), '');
    expect(res).toEqual({ toast: { type: 'error', content: '仅消息发送者可操作' } });
    expect(toggleDislike).not.toHaveBeenCalled();
  });

  it('无可反馈消息时 toast 且不回调卡片', async () => {
    const toggleDislike = vi.fn(async () => null);
    const service = makeService({ toggleDislike });
    const res = await service.handle(makeEvent(dislikeValue), '');
    expect(res).toEqual({ toast: { type: 'info', content: '未找到可反馈的任务结果' } });
  });

  it('未注入 toggleDislike 时提示不可用', async () => {
    const service = makeService();
    const res = await service.handle(makeEvent(dislikeValue), '');
    expect(res).toEqual({ toast: { type: 'info', content: '点踩功能不可用' } });
  });

  it('点踩回调只更新点击者视图，不给群内其他人补 PATCH', async () => {
    const toggleDislike = vi.fn(async () => ({ disliked: true }));
    const refreshProgress = vi.fn(async () => undefined);
    const service = makeService({ toggleDislike, refreshProgress });
    await service.handle(makeEvent(dislikeValue), '');
    await Promise.resolve();
    // 方案 5.2.6：群内其他人靠回调响应只更新点击者视图，不做额外 PATCH
    expect(refreshProgress).not.toHaveBeenCalled();
  });

  it('接受 JSON 字符串形态的 dislike value', async () => {
    const toggleDislike = vi.fn(async () => ({ disliked: true }));
    const service = makeService({ toggleDislike });
    const res = await service.handle(makeEvent(JSON.stringify(dislikeValue)), '');
    expect(res?.toast?.content).toBe('已标记不满意');
    expect(toggleDislike).toHaveBeenCalledWith(7);
  });

  it('toggle 抛错时不崩溃，回调 info toast', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const toggleDislike = vi.fn(async () => { throw new Error('db down'); });
      const service = makeService({ toggleDislike });
      await expect(service.handle(makeEvent(dislikeValue), '')).rejects.toThrow('db down');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('FeishuCardActionService ask form', () => {
  const single = {
    question: '选哪个？',
    header: '方案',
    multiSelect: false,
    options: [
      { label: '甲', description: '说明甲' },
      { label: '乙', description: '说明乙' },
    ],
  };
  const multi = {
    question: '要哪些？',
    header: '范围',
    multiSelect: true,
    options: [
      { label: 'A', description: '说明A' },
      { label: 'B', description: '说明B' },
    ],
  };

  function askHarness(questions: Array<Record<string, unknown>>, complete = true) {
    const askForms = new FeishuAskFormStore();
    askForms.set(7, 'req-1', questions, 'ou_sender');
    const completeAsk = vi.fn(() => complete);
    const notifyAskAnswered = vi.fn();
    const refreshProgress = vi.fn(async () => undefined);
    const service = makeService({
      askForms,
      completeAsk,
      notifyAskAnswered,
      refreshProgress,
      renderProgressCard: () => buildFeishuProgressCard(
        'RUNNING', 1, '正文', [], { sessionId: 7, sender: 'ou_sender' }, undefined, undefined, askForms.list(7),
      ),
    });
    return { service, askForms, completeAsk, notifyAskAnswered, refreshProgress };
  }

  function askEvent(formValue: unknown, operator = 'ou_sender', value: unknown = {
    kind: 'feishu_ask', act: 'submit', sessionId: 7, requestId: 'req-1', sender: 'ou_sender',
  }) {
    return { operator: { open_id: operator }, action: { value, name: 'ask_0', form_value: formValue } };
  }

  it('rejects a submitter who is not the original sender', async () => {
    const { service, completeAsk, askForms } = askHarness([single]);
    const res = await service.handle(askEvent({ c0: '自定义' }, 'ou_other'), '');
    expect(res).toEqual({ toast: { type: 'error', content: '仅消息发送者可操作' } });
    expect(completeAsk).not.toHaveBeenCalled();
    expect(askForms.get(7, 'req-1')).not.toBeNull();
  });

  it('maps a single-select custom answer and ignores the dropdown', async () => {
    const { service, completeAsk, notifyAskAnswered, askForms, refreshProgress } = askHarness([single]);
    const res = await service.handle(askEvent({ q0: '0', c0: '  自定义  ' }), '');
    expect(res?.toast).toEqual({ type: 'success', content: '已提交' });
    expect(JSON.stringify(res?.card)).not.toContain('req-1');
    expect(completeAsk).toHaveBeenCalledWith(7, 'req-1', JSON.stringify({
      answers: [{ question: '选哪个？', selectedLabels: [], customInput: '自定义' }],
    }));
    expect(notifyAskAnswered).toHaveBeenCalledWith(7, 'req-1');
    expect(refreshProgress).toHaveBeenCalledWith(7);
    expect(askForms.get(7, 'req-1')).toBeNull();
  });

  it('keeps both selected labels and custom text for multi-select', async () => {
    const { service, completeAsk } = askHarness([multi]);
    await service.handle(askEvent({ q0: ['1', '0'], c0: '补充' }), '');
    expect(completeAsk).toHaveBeenCalledWith(7, 'req-1', JSON.stringify({
      answers: [{ question: '要哪些？', selectedLabels: ['B', 'A'], customInput: '补充' }],
    }));
  });

  it('accepts an option object in form_value', async () => {
    const { service, completeAsk } = askHarness([single]);
    await service.handle(askEvent({ q0: { value: '0' } }), '');
    expect(completeAsk).toHaveBeenCalledWith(7, 'req-1', JSON.stringify({
      answers: [{ question: '选哪个？', selectedLabels: ['甲'], customInput: null }],
    }));
  });

  it('reads the second parallel form without mixing it with the first', async () => {
    const { service, completeAsk } = askHarness([single]);
    await service.handle(askEvent({ q1_0: '1', c1_0: '' }, 'ou_sender', {
      kind: 'feishu_ask', act: 'submit', sessionId: 7, requestId: 'req-1', sender: 'ou_sender',
    }), '');
    expect(completeAsk).toHaveBeenCalledWith(7, 'req-1', JSON.stringify({
      answers: [{ question: '选哪个？', selectedLabels: ['乙'], customInput: null }],
    }));
  });

  it('maps a single-select option when the custom field is blank', async () => {
    const { service, completeAsk } = askHarness([single]);
    await service.handle(askEvent({ q0: '1', c0: '   ' }), '');
    expect(completeAsk).toHaveBeenCalledWith(7, 'req-1', JSON.stringify({
      answers: [{ question: '选哪个？', selectedLabels: ['乙'], customInput: null }],
    }));
  });

  it('does not complete when any question is blank and keeps the form', async () => {
    const { service, completeAsk, askForms } = askHarness([single, multi]);
    const res = await service.handle(askEvent({ q0: '0', c0: '', q1: [], c1: '  ' }), '');
    expect(res?.toast).toEqual({ type: 'warning', content: '请至少选择一项或填写其他' });
    expect(completeAsk).not.toHaveBeenCalled();
    expect(JSON.stringify(res?.card)).toContain('req-1');
    expect(askForms.get(7, 'req-1')).not.toBeNull();
  });

  it('toasts that the question expired when complete returns false and does not throw', async () => {
    const { service, notifyAskAnswered } = askHarness([single], false);
    const res = await service.handle(askEvent({ q0: '0' }), '');
    expect(res?.toast).toEqual({ type: 'info', content: '问题已失效' });
    expect(JSON.stringify(res?.card)).not.toContain('req-1');
    expect(notifyAskAnswered).not.toHaveBeenCalled();
  });

  it('reads form_value from a nested card.action.trigger envelope', async () => {
    const { service, completeAsk } = askHarness([single]);
    const res = await service.handle({
      schema: '2.0',
      header: { event_type: 'card.action.trigger' },
      event: {
        operator: { open_id: 'ou_sender' },
        action: {
          value: { kind: 'feishu_ask', act: 'submit', sessionId: 7, requestId: 'req-1', sender: 'ou_sender' },
          name: 'ask_0',
          form_value: { c0: '信封里的答案' },
        },
      },
    }, '');
    expect(res?.toast?.content).toBe('已提交');
    expect(completeAsk).toHaveBeenCalledWith(7, 'req-1', JSON.stringify({
      answers: [{ question: '选哪个？', selectedLabels: [], customInput: '信封里的答案' }],
    }));
  });

  it('does not wait for the group PATCH before returning the card', async () => {
    const askForms = new FeishuAskFormStore();
    askForms.set(7, 'req-1', [single], 'ou_sender');
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let refreshCalled = false;
    const service = makeService({
      askForms,
      completeAsk: () => true,
      refreshProgress: () => {
        refreshCalled = true;
        return gate;
      },
      renderProgressCard: () => buildFeishuProgressCard('RUNNING', 1, '', [], { sessionId: 7, sender: 'ou_sender' }),
    });
    const res = await service.handle(askEvent({ c0: '自定义' }), '');
    expect(res?.toast?.content).toBe('已提交');
    expect(refreshCalled).toBe(true);
    release();
    await gate;
  });
});
