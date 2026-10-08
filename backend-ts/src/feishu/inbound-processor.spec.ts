import { describe, expect, it, vi } from 'vitest';
import { normalizeFeishuEvent } from './event-normalizer.js';
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
  updateGroupMessageContent: vi.fn(async () => undefined),
  updateGroupMessageSenderName: vi.fn(async () => undefined),
  markGroupMessageEnriched: vi.fn(async () => undefined),
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
    expect(messageService.recordGroupMessage).toHaveBeenCalledWith('1', expect.objectContaining({ messageId: 'om_1' }), true, { enrichPending: false });
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

  it('skips quote injection when thread reply has parent_id === root_id (thread root)', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const resolveQuotedMessage = vi.fn(async () => '[引用消息] 内容');
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService,
      authorizeSender: async () => true,
      resolveQuotedMessage,
    });
    await processor.process('1', makeEvent({
      isBotMentioned: true, parentId: 'om_root', rootId: 'om_root', threadId: 'omt_abc',
    }));
    // 话题内回复的 parent_id 恒指向话题根，不是用户主动引用 → 不注入。
    expect(resolveQuotedMessage).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ quotedContext: undefined }));
  });

  it('injects quote when thread reply explicitly quotes another message (parent_id ≠ root_id)', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const resolveQuotedMessage = vi.fn(async () => '[引用消息] 被引用的回复');
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService,
      authorizeSender: async () => true,
      resolveQuotedMessage,
    });
    await processor.process('1', makeEvent({
      isBotMentioned: true, parentId: 'om_other', rootId: 'om_root', threadId: 'omt_abc',
    }));
    // 用户显式引用了话题内某条回复 → 正常注入。
    expect(resolveQuotedMessage).toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ quotedContext: '[引用消息] 被引用的回复' }));
  });

  it('still injects quote for non-thread reply where parent_id === root_id', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const resolveQuotedMessage = vi.fn(async () => '[引用消息] 内容');
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService,
      authorizeSender: async () => true,
      resolveQuotedMessage,
    });
    // 非话题群：root_id 通常也等于 parent_id（引用的那条消息就是回复树的根），
    // 守卫必须带 threadId 条件，不能误伤。
    await processor.process('1', makeEvent({ isBotMentioned: true, parentId: 'om_parent', rootId: 'om_parent' }));
    expect(resolveQuotedMessage).toHaveBeenCalled();
  });

  it('triggers existing thread message without @bot when thread session mapping hits', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService,
      authorizeSender: async () => true,
      resolveThreadSession: async () => ({ sessionId: 10 }),
    });
    // 无 @、有 threadId、映射命中（机器人已在该话题中）→ 免 @ 触发。
    await processor.process('1', makeEvent({ isBotMentioned: false, threadId: 'omt_abc' }));
    expect(messageService.recordGroupMessage).toHaveBeenCalledWith('1', expect.anything(), true, { enrichPending: false });
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it('does not trigger new topic without @bot (no thread session mapping)', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService,
      authorizeSender: async () => true,
      resolveThreadSession: async () => null,
    });
    // 无 @、有 threadId、映射不存在（新话题/机器人不在）→ 不触发。
    await processor.process('1', makeEvent({ isBotMentioned: false, threadId: 'omt_abc' }));
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('triggers new topic with @bot even without existing mapping', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService,
      authorizeSender: async () => true,
      resolveThreadSession: async () => null,
    });
    // @bot → mentioned 已为 true，不依赖映射查询，正常触发。
    await processor.process('1', makeEvent({ isBotMentioned: true, threadId: 'omt_abc' }));
    expect(onMessage).toHaveBeenCalledOnce();
  });

  it('only records group message when bot not mentioned', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), { messageService });
    await processor.process('1', makeEvent({ isBotMentioned: false }));
    expect(messageService.recordGroupMessage).toHaveBeenCalledWith('1', expect.anything(), false, { enrichPending: false });
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

  it('sends unauthorized card in p2p without falling back to text', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    const sendReply = vi.fn(async () => undefined);
    const sendUnauthorizedCard = vi.fn(async () => true);
    const processor = new FeishuInboundProcessor(makeHandler(), {
      messageService,
      authorizeSender: async () => false,
      sendReply,
      sendUnauthorizedCard,
    });
    await processor.process('1', makeEvent({ chatType: 'p2p' }));
    expect(sendUnauthorizedCard).toHaveBeenCalledOnce();
    expect(sendReply).not.toHaveBeenCalled();
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

  it('pre-downloads group image in background and upgrades log content with local path', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    messageService.recordGroupMessage.mockResolvedValueOnce(101);
    const downloadGroupImage = vi.fn(async (_accountId: string, _event: FeishuNormalizedMessage) =>
      '/ws/feishu-chat/1/oc_group/feishu-image-om_1.png');
    const processor = new FeishuInboundProcessor(makeHandler(), {
      messageService,
      downloadGroupImage,
    });
    await processor.process('1', makeEvent({ messageType: 'image', imageKey: 'img_1', text: '', isBotMentioned: false }));
    expect(downloadGroupImage).toHaveBeenCalledOnce();
    // 先按懒加载占位符立即落日志，后台下载完成后再升级为本地路径引用。
    expect(messageService.recordGroupMessage).toHaveBeenCalledWith('1',
      expect.objectContaining({ text: '[图片 msg=om_1]' }), false, { enrichPending: true });
    await vi.waitFor(() => expect(messageService.updateGroupMessageContent)
      .toHaveBeenCalledWith(101, '[图片已保存: @{/ws/feishu-chat/1/oc_group/feishu-image-om_1.png}@]'));
    expect(messageService.completeInboundMessage).toHaveBeenCalledWith('1', 'om_1');
  });

  it('keeps lazy placeholder when group image pre-download fails', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    messageService.recordGroupMessage.mockResolvedValueOnce(102);
    messageService.updateGroupMessageContent.mockClear();
    const downloadGroupImage = vi.fn(async (_accountId: string, _event: FeishuNormalizedMessage) => {
      throw new Error('download failed');
    });
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const processor = new FeishuInboundProcessor(makeHandler(), { messageService, downloadGroupImage });
    try {
      await processor.process('1', makeEvent({ messageType: 'image', imageKey: 'img_1', text: '', isBotMentioned: false }));
      expect(messageService.recordGroupMessage).toHaveBeenCalledWith('1',
        expect.objectContaining({ text: '[图片 msg=om_1]' }), false, { enrichPending: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(messageService.updateGroupMessageContent).not.toHaveBeenCalled();
    } finally {
      consoleWarn.mockRestore();
    }
  });

  it('appends earlier group messages to log before a following trigger reads context under concurrency', async () => {
    // 回归：图片消息与 @ 触发消息并发入站时，若图片先下载后入库（或入库晚于触发读上下文），
    // 触发时的水位线会越过图片日志行，导致图片永远进不了 Agent 会话上下文。
    const calls: string[] = [];
    let releaseDownload!: () => void;
    const downloadGate = new Promise<void>((resolve) => { releaseDownload = resolve; });
    const svc = {
      claimInboundMessage: vi.fn(async () => true),
      releaseInboundMessage: vi.fn(async () => undefined),
      completeInboundMessage: vi.fn(async () => undefined),
      recordGroupMessage: vi.fn(async (_accountId: string, event: FeishuNormalizedMessage, _m: boolean) => {
        calls.push(`record:${event.text}`);
        return event.messageId === 'om_img' ? 10 : 11;
      }),
      buildGroupContext: vi.fn(async () => {
        calls.push('context');
        return { conversation: {} as never, messages: [], prompt: 'ctx' };
      }),
      updateGroupMessageContent: vi.fn(async () => undefined),
      updateGroupMessageSenderName: vi.fn(async () => undefined),
    };
    const onMessage = vi.fn(async (ctx: FeishuInboundContext) => ({ text: ctx.groupContext ?? '' }));
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService: svc as never,
      authorizeSender: async () => true,
      downloadGroupImage: async () => {
        await downloadGate;
        return '/ws/img.png';
      },
    });
    const imageDone = processor.process('1', makeEvent({ messageId: 'om_img', messageType: 'image', imageKey: 'k', text: '', isBotMentioned: false }));
    const triggerDone = processor.process('1', makeEvent({ messageId: 'om_ment', text: '@bot 看图', isBotMentioned: true }));
    await triggerDone;
    releaseDownload();
    await imageDone;
    await vi.waitFor(() => expect(svc.updateGroupMessageContent).toHaveBeenCalled());
    const imageRecordIndex = calls.findIndex((call) => call.startsWith('record:') && call.includes('[图片 msg=om_img]'));
    expect(imageRecordIndex).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('context')).toBeGreaterThan(imageRecordIndex);
    expect(calls[0]).toBe('record:[图片 msg=om_img]');
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

  it('pre-downloads group file in background and upgrades log content with local path', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    messageService.recordGroupMessage.mockResolvedValueOnce(201);
    const downloadGroupFile = vi.fn(async () => '/ws/feishu-chat/1/oc_group/report.pdf');
    const processor = new FeishuInboundProcessor(makeHandler(), { messageService, downloadGroupFile });
    await processor.process('1', makeEvent({ messageType: 'file', fileKey: 'file_1', fileName: 'report.pdf', text: '', isBotMentioned: false }));
    expect(messageService.recordGroupMessage).toHaveBeenCalledWith('1',
      expect.objectContaining({ text: '[文件:report.pdf msg=om_1]' }), false, { enrichPending: true });
    await vi.waitFor(() => expect(downloadGroupFile).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(messageService.updateGroupMessageContent)
      .toHaveBeenCalledWith(201, '[文件已保存: @{/ws/feishu-chat/1/oc_group/report.pdf}@]'));
  });

  it('does not build group context when a mentioned file is ingested', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    messageService.recordGroupMessage.mockResolvedValueOnce(202);
    messageService.buildGroupContext.mockClear();
    const onMessage = vi.fn(async () => null);
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService,
      authorizeSender: async () => true,
    });
    await processor.process('1', makeEvent({
      messageType: 'file', fileKey: 'file_1', fileName: 'a.pdf', text: '', isBotMentioned: true,
    }));
    expect(onMessage).toHaveBeenCalledOnce();
    expect(messageService.buildGroupContext).not.toHaveBeenCalled();
  });

  it('normalizes p2p post image+text keeping text and image keys (图片+文字)', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    const onMessage = vi.fn(async (ctx: FeishuInboundContext) => ({ text: ctx.text }));
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService,
      authorizeSender: async () => true,
    });
    await processor.process('1', {
      ...makeEvent({ chatType: 'p2p', messageType: 'post', text: '', isBotMentioned: false }),
      imageKey: 'img_a',
      imageKeys: ['img_a'],
      content: { title: '', content: [[{ tag: 'text', text: '这个图片的内容是什么?' }, { tag: 'img', image_key: 'img_a' }]] },
    } as FeishuNormalizedMessage);
    // post 占位文本 = 原文字 + [图片] 占位；图片由 downloadMedia 按 imageKeys 注入。
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: '这个图片的内容是什么? [图片]',
      imageKeys: ['img_a'],
    }));
  });

  it('pre-downloads post rich-text images in group and appends refs without dropping text', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    messageService.recordGroupMessage.mockResolvedValueOnce(103);
    const downloadGroupImage = vi.fn(async (_accountId: string, _event: FeishuNormalizedMessage, imageKey: string, index: number) =>
      `/ws/feishu-image-${imageKey}-${index}.png`);
    const processor = new FeishuInboundProcessor(makeHandler(), {
      messageService,
      downloadGroupImage,
    });
    await processor.process('1', makeEvent({
      messageId: 'om_post',
      messageType: 'post',
      text: '这个图片的内容是什么? [图片]',
      imageKey: 'img_a',
      imageKeys: ['img_a', 'img_b'],
      isBotMentioned: false,
    }));
    await vi.waitFor(() => expect(messageService.updateGroupMessageContent).toHaveBeenCalledWith(103,
      '这个图片的内容是什么? [图片]\n@{/ws/feishu-image-img_a-0.png}@\n@{/ws/feishu-image-img_b-1.png}@'));
    expect(downloadGroupImage).toHaveBeenCalledTimes(2);
    expect(downloadGroupImage).toHaveBeenCalledWith('1', expect.anything(), 'img_a', 0);
    expect(downloadGroupImage).toHaveBeenCalledWith('1', expect.anything(), 'img_b', 1);
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

  it('replaces Feishu card upgrade-fallback text with placeholder when logging group cards', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    messageService.recordGroupMessage.mockResolvedValueOnce(201);
    messageService.updateGroupMessageContent.mockClear();
    const processor = new FeishuInboundProcessor(makeHandler(), { messageService });
    await processor.process('1', makeEvent({
      messageId: 'om_card_deg',
      messageType: 'interactive',
      senderType: 'app',
      senderId: 'ou_253023b8',
      text: '请升级至最新版本客户端，以查看内容',
      content: { text: '请升级至最新版本客户端，以查看内容' },
      isBotMentioned: false,
    }));
    expect(messageService.recordGroupMessage).toHaveBeenCalledWith('1',
      expect.objectContaining({ text: '[卡片消息]' }), false, { enrichPending: true });
  });

  it('upgrades degraded group card log content via message detail fetch', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    messageService.recordGroupMessage.mockResolvedValueOnce(202);
    messageService.updateGroupMessageContent.mockClear();
    const resolveMessageText = vi.fn(async () => '状态：处理完成 · 任务已完成');
    const processor = new FeishuInboundProcessor(makeHandler(), { messageService, resolveMessageText });
    await processor.process('1', makeEvent({
      messageId: 'om_card_up',
      messageType: 'interactive',
      senderType: 'app',
      senderId: 'ou_253023b8',
      text: '请升级至最新版本客户端，以查看内容',
      isBotMentioned: false,
    }));
    expect(messageService.recordGroupMessage).toHaveBeenCalledWith('1',
      expect.objectContaining({ text: '[卡片消息]' }), false, { enrichPending: true });
    await vi.waitFor(() => expect(messageService.updateGroupMessageContent)
      .toHaveBeenCalledWith(202, '状态：处理完成 · 任务已完成'));
    expect(resolveMessageText).toHaveBeenCalledWith('1', 'om_card_up');
  });

  it('expands a private merge_forward before onMessage and keeps the English text when expansion fails', async () => {
    const excerpt = '【合并转发，共 1 条】\n[2026-10-08 09:12] 张三：大家好';
    const steps: string[] = [];
    const expandMergeForward = vi.fn(async () => {
      steps.push('expand');
      return excerpt;
    });
    const onMessage = vi.fn(async () => {
      steps.push('onMessage');
      return { text: 'r' };
    });
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService,
      authorizeSender: async () => {
        steps.push('auth');
        return true;
      },
      expandMergeForward,
      resolveMergeWorkspace: async () => '/ws/private-7',
    });
    await processor.process('1', makeEvent({
      chatType: 'p2p', messageType: 'merge_forward', text: 'Merged and Forwarded Message',
    }));
    expect(steps).toEqual(['auth', 'expand', 'onMessage']);
    expect(expandMergeForward).toHaveBeenCalledWith('1', 'om_1', '/ws/private-7');
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ text: excerpt }));

    const failed = vi.fn(async (ctx: FeishuInboundContext) => ({ text: ctx.text }));
    const failing = new FeishuInboundProcessor(makeHandler(failed), {
      messageService,
      authorizeSender: async () => true,
      expandMergeForward: async () => null,
    });
    await failing.process('1', makeEvent({
      chatType: 'p2p', messageId: 'om_fail', messageType: 'merge_forward', text: 'Merged and Forwarded Message',
    }));
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ text: 'Merged and Forwarded Message' }));
  });

  it('does not expand a private merge_forward for an unbound sender', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    const expandMergeForward = vi.fn(async () => '【合并转发，共 1 条】');
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService,
      authorizeSender: async () => false,
      expandMergeForward,
      sendReply: async () => undefined,
      sendUnauthorizedCard: async () => true,
    });
    await processor.process('1', makeEvent({
      chatType: 'p2p', messageType: 'merge_forward', text: 'Merged and Forwarded Message',
    }));
    expect(expandMergeForward).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('awaits group mention expansion, rewrites the log, then delivers the excerpt', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    messageService.recordGroupMessage.mockResolvedValueOnce(301);
    messageService.updateGroupMessageContent.mockClear();
    messageService.markGroupMessageEnriched.mockClear();
    const excerpt = '【合并转发，共 1 条】\n[2026-10-08 09:12] 张三：大家好';
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => { release = resolve; });
    const expandMergeForward = vi.fn(() => gate);
    const onMessage = vi.fn(async (ctx: FeishuInboundContext) => ({ text: ctx.text }));
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService,
      authorizeSender: async () => true,
      expandMergeForward,
      resolveMergeWorkspace: () => '/ws/oc_group',
    });
    const pending = processor.process('1', makeEvent({
      messageId: 'om_merge',
      messageType: 'merge_forward',
      text: 'Merged and Forwarded Message',
      isBotMentioned: true,
    }));
    await vi.waitFor(() => expect(expandMergeForward).toHaveBeenCalledWith('1', 'om_merge', '/ws/oc_group'));
    expect(onMessage).not.toHaveBeenCalled();
    expect(messageService.updateGroupMessageContent).not.toHaveBeenCalled();
    expect(messageService.recordGroupMessage).toHaveBeenCalledWith('1',
      expect.objectContaining({ text: 'Merged and Forwarded Message' }), true, { enrichPending: true });
    release(excerpt);
    await pending;
    expect(messageService.updateGroupMessageContent).toHaveBeenCalledWith(301, excerpt);
    expect(messageService.markGroupMessageEnriched).toHaveBeenCalledWith(301);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ text: excerpt }));
  });

  it('clears enrich_pending when a mentioned merge_forward fails to expand', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    messageService.recordGroupMessage.mockResolvedValueOnce(302);
    messageService.updateGroupMessageContent.mockClear();
    messageService.markGroupMessageEnriched.mockClear();
    const onMessage = vi.fn(async (ctx: FeishuInboundContext) => ({ text: ctx.text }));
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService,
      authorizeSender: async () => true,
      expandMergeForward: async () => { throw new Error('boom'); },
    });
    await processor.process('1', makeEvent({
      messageType: 'merge_forward', text: 'Merged and Forwarded Message', isBotMentioned: true,
    }));
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ text: 'Merged and Forwarded Message' }));
    expect(messageService.updateGroupMessageContent).not.toHaveBeenCalled();
    expect(messageService.markGroupMessageEnriched).toHaveBeenCalledWith(302);
  });

  it('does not expand a mentioned merge_forward from an unbound sender, but still clears enrich_pending', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    messageService.recordGroupMessage.mockResolvedValueOnce(303);
    messageService.markGroupMessageEnriched.mockClear();
    const expandMergeForward = vi.fn(async () => '【合并转发，共 1 条】');
    const processor = new FeishuInboundProcessor(makeHandler(), {
      messageService,
      authorizeSender: async () => false,
      expandMergeForward,
      sendReply: async () => undefined,
    });
    await processor.process('1', makeEvent({
      messageType: 'merge_forward', text: 'Merged and Forwarded Message', isBotMentioned: true,
    }));
    expect(expandMergeForward).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(messageService.markGroupMessageEnriched).toHaveBeenCalledWith(303));
  });

  it('enriches an unmentioned group merge_forward asynchronously and clears the flag on failure', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    messageService.recordGroupMessage.mockResolvedValueOnce(304);
    messageService.updateGroupMessageContent.mockClear();
    messageService.markGroupMessageEnriched.mockClear();
    const excerpt = '【合并转发，共 2 条】\n[2026-10-08 09:12] 张三：甲';
    const expandMergeForward = vi.fn(async () => excerpt);
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService,
      expandMergeForward,
      resolveMergeWorkspace: async () => '/ws/oc_group',
    });
    await processor.process('1', makeEvent({
      messageId: 'om_bg',
      messageType: 'merge_forward',
      text: 'Merged and Forwarded Message',
      isBotMentioned: false,
    }));
    expect(onMessage).not.toHaveBeenCalled();
    expect(messageService.recordGroupMessage).toHaveBeenCalledWith('1',
      expect.objectContaining({ text: 'Merged and Forwarded Message' }), false, { enrichPending: true });
    await vi.waitFor(() => expect(messageService.updateGroupMessageContent).toHaveBeenCalledWith(304, excerpt));
    expect(messageService.markGroupMessageEnriched).toHaveBeenCalledWith(304);
    expect(expandMergeForward).toHaveBeenCalledWith('1', 'om_bg', '/ws/oc_group');

    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    messageService.recordGroupMessage.mockResolvedValueOnce(305);
    messageService.updateGroupMessageContent.mockClear();
    messageService.markGroupMessageEnriched.mockClear();
    const failing = new FeishuInboundProcessor(makeHandler(), {
      messageService,
      expandMergeForward: async () => null,
    });
    await failing.process('1', makeEvent({
      messageId: 'om_bg_fail',
      messageType: 'merge_forward',
      text: 'Merged and Forwarded Message',
      isBotMentioned: false,
    }));
    await vi.waitFor(() => expect(messageService.markGroupMessageEnriched).toHaveBeenCalledWith(305));
    expect(messageService.updateGroupMessageContent).not.toHaveBeenCalled();
  });

  it('expands a thread merge_forward without an explicit mention when the thread session already exists', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    messageService.recordGroupMessage.mockResolvedValueOnce(306);
    const excerpt = '【合并转发，共 1 条】\n[2026-10-08 09:12] 张三：话题里';
    const expandMergeForward = vi.fn(async () => excerpt);
    const onMessage = vi.fn(async (ctx: FeishuInboundContext) => ({ text: ctx.text }));
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService,
      authorizeSender: async () => true,
      resolveThreadSession: async () => ({ sessionId: 9 }),
      expandMergeForward,
    });
    await processor.process('1', makeEvent({
      messageType: 'merge_forward',
      text: 'Merged and Forwarded Message',
      threadId: 'omt_1',
      isBotMentioned: false,
    }));
    expect(expandMergeForward).toHaveBeenCalledOnce();
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ text: excerpt }));
  });

  it('clears enrich_pending when authorizeSender throws after a mentioned merge_forward is logged', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    messageService.recordGroupMessage.mockResolvedValueOnce(401);
    messageService.markGroupMessageEnriched.mockClear();
    const expandMergeForward = vi.fn(async () => '【合并转发，共 1 条】');
    const processor = new FeishuInboundProcessor(makeHandler(), {
      messageService,
      authorizeSender: async () => { throw new Error('db down'); },
      expandMergeForward,
    });
    await expect(processor.process('1', makeEvent({
      messageType: 'merge_forward',
      text: 'Merged and Forwarded Message',
      isBotMentioned: true,
    }))).rejects.toThrow('db down');
    expect(messageService.recordGroupMessage).toHaveBeenCalledWith('1',
      expect.objectContaining({ text: 'Merged and Forwarded Message' }), true, { enrichPending: true });
    expect(messageService.markGroupMessageEnriched).toHaveBeenCalledWith(401);
    expect(expandMergeForward).not.toHaveBeenCalled();
    expect(messageService.releaseInboundMessage).toHaveBeenCalledWith('1', 'om_1');
  });

  it('replaces post at-mentions on a normal inbound post', async () => {
    messageService.claimInboundMessage.mockResolvedValueOnce(true);
    const event = normalizeFeishuEvent({
      header: { app_id: 'cli_mybot' },
      event: {
        sender: { sender_id: { open_id: 'ou_user', union_id: 'on_user' }, sender_type: 'user' },
        message: {
          message_id: 'om_post_at', chat_id: 'oc_p2p', chat_type: 'p2p', message_type: 'post',
          content: JSON.stringify({ content: [[
            { tag: 'at', user_id: '@_user_1', user_name: '李四' },
            { tag: 'text', text: ' 大家好' },
          ]] }),
          mentions: [{ key: '@_user_1', id: { open_id: 'ou_ls' }, name: '李四' }],
        },
      },
    });
    const onMessage = vi.fn(async (ctx: FeishuInboundContext) => ({ text: ctx.text }));
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService,
      authorizeSender: async () => true,
    });
    await processor.process('1', event!);
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({ text: '@李四 大家好' }));
    expect(onMessage.mock.calls[0][0].text).not.toContain('@_user_');
  });
});
