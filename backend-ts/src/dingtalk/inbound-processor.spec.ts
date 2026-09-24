import { describe, expect, it, vi } from 'vitest';
import { DingtalkInboundProcessor } from './inbound-processor.js';
import type { DingtalkInboundHandler, DingtalkNormalizedMessage } from './types.js';

function event(overrides: Partial<DingtalkNormalizedMessage> = {}): DingtalkNormalizedMessage {
  return {
    chatType: 'p2p', conversationId: 'cid', messageId: 'm1', senderUserid: 'staff', senderUnionId: 'union',
    senderName: '张三', msgtype: 'text', text: '你好', downloadCodes: [], fileName: null, quotedText: null, isInAtList: true,
    ...overrides,
  };
}

function processor(handler: DingtalkInboundHandler, options: ConstructorParameters<typeof DingtalkInboundProcessor>[1] = {}) {
  return new DingtalkInboundProcessor(handler, options);
}

describe('DingtalkInboundProcessor', () => {
  it('does not run the handler twice for the same message id', async () => {
    const onMessage = vi.fn(async () => null);
    const claim = vi.fn(async () => false);
    await processor({ onMessage }, {
      messageService: { claimInbound: claim, completeInbound: vi.fn(), releaseInbound: vi.fn() } as never,
      resolveUserId: async () => 7,
    }).process('1', event());
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('allows a FAILED message to be claimed again', async () => {
    const onMessage = vi.fn(async () => null);
    const claim = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const complete = vi.fn();
    const options = {
      messageService: { claimInbound: claim, completeInbound: complete, releaseInbound: vi.fn() } as never,
      resolveUserId: async () => 7,
    };
    const inbound = processor({ onMessage }, options);
    await inbound.process('1', event());
    await inbound.process('1', event());
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith('1', 'm1');
  });

  it('sends a short-link card when the sender is unbound', async () => {
    const onMessage = vi.fn();
    const sendBindingCard = vi.fn(async () => true);
    const sendReply = vi.fn();
    await processor({ onMessage }, {
      resolveUserId: async () => null,
      sendBindingCard,
      sendReply,
      oauthConfigured: () => true,
    }).process('1', event());
    expect(sendBindingCard).toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it('does not send a binding card when staff id is missing', async () => {
    const sendBindingCard = vi.fn();
    const sendReply = vi.fn();
    await processor({ onMessage: vi.fn() }, { sendBindingCard, sendReply }).process('1', event({ senderUserid: null }));
    expect(sendBindingCard).not.toHaveBeenCalled();
    expect(sendReply).toHaveBeenCalledWith('1', expect.anything(), '当前无法识别你的钉钉身份');
  });

  it('logs an unmentioned group message and does not run the agent', async () => {
    const record = vi.fn();
    const onMessage = vi.fn();
    await processor({ onMessage }, {
      messageService: {
        claimInbound: async () => true,
        completeInbound: vi.fn(),
        releaseInbound: vi.fn(),
        recordGroupInbound: record,
      } as never,
      resolveUserId: async () => 7,
    }).process('1', event({ chatType: 'group', isInAtList: false }));
    expect(record).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });
});
