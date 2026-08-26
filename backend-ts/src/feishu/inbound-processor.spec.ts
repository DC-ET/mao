import { describe, expect, it, vi } from 'vitest';
import { FeishuInboundProcessor } from './inbound-processor.js';
import type { FeishuInboundHandler, FeishuInboundContext, FeishuNormalizedMessage, FeishuReply } from './types.js';

function makeEvent(overrides: Partial<FeishuNormalizedMessage> = {}): FeishuNormalizedMessage {
  return {
    eventId: 'evt1', messageId: 'om_1', chatId: 'oc_group', chatType: 'group',
    senderId: 'ou_user', senderUnionId: 'on_user', senderType: 'user', messageType: 'text',
    text: 'hello', mentions: [], isBotMentioned: false, content: {}, rawEvent: {},
    ...overrides,
  };
}

function makeHandler(onMessage?: (ctx: FeishuInboundContext) => Promise<FeishuReply | null>): FeishuInboundHandler {
  return {
    authorizeDirectMessage: () => true,
    onMessage: onMessage ?? (async () => ({ text: 'reply' })),
  };
}

const messageService = {
  claimInboundMessage: vi.fn(async () => true),
  releaseInboundMessage: vi.fn(async () => undefined),
  completeInboundMessage: vi.fn(async () => undefined),
  recordGroupMessage: vi.fn(async () => 1),
  buildGroupContext: vi.fn(async () => ({ conversation: {} as never, messages: [], prompt: 'group context' })),
};

describe('FeishuInboundProcessor', () => {
  it('drops messages without sender or message id', async () => {
    const processor = new FeishuInboundProcessor(makeHandler(), { messageService });
    await processor.process('1', makeEvent({ senderId: null }));
    await processor.process('1', makeEvent({ messageId: null }));
    expect(messageService.claimInboundMessage).not.toHaveBeenCalled();
  });

  it('skips duplicate inbound messages when claim fails', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(false);
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), { messageService });
    await processor.process('1', makeEvent());
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('records group message and triggers agent when mentioned', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    const onMessage = vi.fn(async (ctx: FeishuInboundContext) => ({ text: `echo ${ctx.text}` }));
    const sendReply = vi.fn(async () => undefined);
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService,
      authorizeSender: async () => true,
      sendReply,
    });
    await processor.process('1', makeEvent({ isBotMentioned: true }));
    expect(messageService.recordGroupMessage).toHaveBeenCalledWith('1', expect.objectContaining({ messageId: 'om_1' }), true);
    expect(onMessage).toHaveBeenCalledOnce();
    expect(sendReply).toHaveBeenCalledWith('1', expect.anything(), 'echo hello');
    expect(messageService.completeInboundMessage).toHaveBeenCalledWith('1', 'om_1');
  });

  it('resolves quoted message content into quotedContext when replying', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const resolveQuotedMessage = vi.fn(async (_accountId: string, event: FeishuNormalizedMessage) =>
      event.parentId == null ? null : '[引用消息] 告警内容');
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService,
      authorizeSender: async () => true,
      resolveQuotedMessage,
    });
    await processor.process('1', makeEvent({ isBotMentioned: true, parentId: 'om_parent' }));
    expect(resolveQuotedMessage).toHaveBeenCalledWith('1', expect.objectContaining({ parentId: 'om_parent' }));
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ quotedContext: '[引用消息] 告警内容' }));
  });

  it('skips quote resolution when message has no parent', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const resolveQuotedMessage = vi.fn();
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService,
      authorizeSender: async () => true,
      resolveQuotedMessage,
    });
    await processor.process('1', makeEvent({ isBotMentioned: true }));
    expect(resolveQuotedMessage).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ quotedContext: undefined }));
  });

  it('degrades to no quote when quote resolution fails', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService,
      authorizeSender: async () => true,
      resolveQuotedMessage: vi.fn(async () => { throw new Error('api down'); }),
    });
    await processor.process('1', makeEvent({ isBotMentioned: true, parentId: 'om_parent' }));
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ quotedContext: undefined }));
  });

  it('only records group message when bot not mentioned', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), { messageService });
    await processor.process('1', makeEvent({ isBotMentioned: false }));
    expect(messageService.recordGroupMessage).toHaveBeenCalledWith('1', expect.anything(), false);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('sends unauthorized guide without executing agent', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const sendReply = vi.fn(async () => undefined);
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService,
      authorizeSender: async () => false,
      sendReply,
    });
    await processor.process('1', makeEvent({ isBotMentioned: true }));
    expect(onMessage).not.toHaveBeenCalled();
    expect(sendReply).toHaveBeenCalledWith('1', expect.anything(), expect.stringContaining('绑定'));
  });

  it('uses customized unauthorized text with binding link', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    const sendReply = vi.fn(async () => undefined);
    const processor = new FeishuInboundProcessor(makeHandler(), {
      messageService,
      authorizeSender: async () => false,
      sendReply,
      unauthorizedText: async () => '请绑定：https://example.com/bind',
    });
    await processor.process('1', makeEvent({ isBotMentioned: true, chatType: 'group' }));
    expect(sendReply).toHaveBeenCalledWith('1', expect.anything(), '请绑定：https://example.com/bind');
  });

  it('normalizes image message to placeholder with message id', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    const onMessage = vi.fn(async (ctx: FeishuInboundContext) => ({ text: ctx.text }));
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService,
      authorizeSender: async () => true,
    });
    await processor.process('1', makeEvent({ chatType: 'p2p', messageType: 'image', imageKey: 'img_1', text: '', isBotMentioned: false }));
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ text: '[图片 msg=om_1]' }));
  });

  it('pre-downloads group image and embeds local path into text', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    const downloadGroupImage = vi.fn(async (_accountId: string, _event: FeishuNormalizedMessage) =>
      '/ws/feishu-chat/1/oc_group/feishu-image-om_1.png');
    const processor = new FeishuInboundProcessor(makeHandler(), {
      messageService,
      downloadGroupImage,
    });
    await processor.process('1', makeEvent({ messageType: 'image', imageKey: 'img_1', text: '', isBotMentioned: false }));
    expect(downloadGroupImage).toHaveBeenCalledOnce();
    expect(messageService.recordGroupMessage).toHaveBeenCalledWith('1',
      expect.objectContaining({ text: '[图片已保存: @{/ws/feishu-chat/1/oc_group/feishu-image-om_1.png}@]' }), false);
  });

  it('keeps lazy placeholder when group image pre-download fails', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    const downloadGroupImage = vi.fn(async (_accountId: string, _event: FeishuNormalizedMessage) => {
      throw new Error('download failed');
    });
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const processor = new FeishuInboundProcessor(makeHandler(), { messageService, downloadGroupImage });
    try {
      await processor.process('1', makeEvent({ messageType: 'image', imageKey: 'img_1', text: '', isBotMentioned: false }));
      expect(messageService.recordGroupMessage).toHaveBeenCalledWith('1',
        expect.objectContaining({ text: '[图片 msg=om_1]' }), false);
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('does not pre-download images for p2p messages', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    const downloadGroupImage = vi.fn(async () => '/tmp/x.png');
    const processor = new FeishuInboundProcessor(makeHandler(), { messageService, downloadGroupImage });
    await processor.process('1', makeEvent({ chatType: 'p2p', messageType: 'image', imageKey: 'img_1', text: '' }));
    expect(downloadGroupImage).not.toHaveBeenCalled();
  });

  it('normalizes file message to placeholder with message id', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    const onMessage = vi.fn(async (ctx: FeishuInboundContext) => ({ text: ctx.text }));
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService,
      authorizeSender: async () => true,
    });
    await processor.process('1', makeEvent({ chatType: 'p2p', messageType: 'file', fileKey: 'file_1', fileName: 'a.pdf', text: '', isBotMentioned: false }));
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ text: '[文件:a.pdf msg=om_1]' }));
  });

  it('releases claim when handler throws', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    const processor = new FeishuInboundProcessor(makeHandler(async () => { throw new Error('boom'); }), {
      messageService,
      authorizeSender: async () => true,
    });
    await expect(processor.process('1', makeEvent({ isBotMentioned: true }))).rejects.toThrow('boom');
    expect(messageService.releaseInboundMessage).toHaveBeenCalledWith('1', 'om_1');
  });
});
