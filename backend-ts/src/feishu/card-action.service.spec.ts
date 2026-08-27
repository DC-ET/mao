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
  patchCard?: (botId: number, cardMessageId: string, card: Record<string, unknown>) => Promise<void>;
} = {}) {
  const queuePort: FeishuCardActionPort = {
    findByCardMessageId: vi.fn(async () => null),
    jumpToFront: vi.fn(async () => false),
    cancel: vi.fn(async () => 'CANCELLED'),
    ...overrides.queuePort,
  };
  const interrupt = overrides.interrupt ?? vi.fn();
  const patchCard = overrides.patchCard ?? vi.fn(async () => undefined);
  return new FeishuCardActionService({ queuePort, interrupt, patchCard });
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

  it('cancel patches card on success', async () => {
    const patchCard = vi.fn(async () => undefined);
    const service = makeService({
      queuePort: { findByCardMessageId: vi.fn(async () => row()), cancel: vi.fn(async () => 'CANCELLED') },
      patchCard,
    });
    const res = await service.handle(makeEvent({ kind: 'feishu_queue', queueId: 1, act: 'cancel' }), '');
    expect(res).toBeUndefined();
    expect(patchCard).toHaveBeenCalledWith(1, 'cm_1', expect.objectContaining({ body: expect.anything() }));
  });

  it('cancel returns ALREADY_STARTED toast when already running', async () => {
    const service = makeService({
      queuePort: { findByCardMessageId: vi.fn(async () => row()), cancel: vi.fn(async () => 'ALREADY_STARTED') },
    });
    const res = await service.handle(makeEvent({ kind: 'feishu_queue', queueId: 1, act: 'cancel' }), '');
    expect(res).toEqual({ toast: { type: 'info', content: '该消息已开始执行' } });
  });

  it('run jumps to front, patches card and interrupts session', async () => {
    const patchCard = vi.fn(async () => undefined);
    const interrupt = vi.fn();
    const service = makeService({
      queuePort: { findByCardMessageId: vi.fn(async () => row()), jumpToFront: vi.fn(async () => true) },
      patchCard,
      interrupt,
    });
    const res = await service.handle(makeEvent({ kind: 'feishu_queue', queueId: 1, act: 'run' }), '');
    expect(res).toBeUndefined();
    expect(patchCard).toHaveBeenCalled();
    expect(interrupt).toHaveBeenCalledWith(7);
  });

  it('run without card message id does not patch but still interrupts', async () => {
    const patchCard = vi.fn(async () => undefined);
    const interrupt = vi.fn();
    const service = makeService({
      queuePort: { findByCardMessageId: vi.fn(async () => row({ cardMessageId: null })), jumpToFront: vi.fn(async () => true) },
      patchCard,
      interrupt,
    });
    const res = await service.handle(makeEvent({ kind: 'feishu_queue', queueId: 1, act: 'run' }), '');
    expect(res).toBeUndefined();
    expect(patchCard).not.toHaveBeenCalled();
    expect(interrupt).toHaveBeenCalledWith(7);
  });

  it('handles action value as JSON string (compat)', async () => {
    const patchCard = vi.fn(async () => undefined);
    const interrupt = vi.fn();
    const service = makeService({
      queuePort: { findByCardMessageId: vi.fn(async () => row()), jumpToFront: vi.fn(async () => true) },
      patchCard,
      interrupt,
    });
    const res = await service.handle(makeEvent(JSON.stringify({ kind: 'feishu_queue', queueId: 1, act: 'run' })), '');
    expect(res).toBeUndefined();
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
});
