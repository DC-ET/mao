import { describe, expect, it, vi } from 'vitest';
import { FeishuCardActionService } from './card-action.service.js';
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
  retryFailed?: (sessionId: number, cardMessageId: string) => Promise<
    | { ok: true }
    | { ok: false; reason: 'BUSY' | 'NOT_FAILED' | 'NO_PROGRESS' }
  >;
  patchCard?: (botId: number, cardMessageId: string, card: Record<string, unknown>) => Promise<void>;
  sessionDetailUrl?: (sessionId: number) => Promise<string | undefined> | string | undefined;
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
    ...(overrides.retryFailed != null ? { retryFailed: overrides.retryFailed } : {}),
    ...(overrides.sessionDetailUrl != null ? { sessionDetailUrl: overrides.sessionDetailUrl } : {}),
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

  it('progress retry by original sender starts retry and returns RUNNING card', async () => {
    const retryFailed = vi.fn(async () => ({ ok: true as const }));
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
});
