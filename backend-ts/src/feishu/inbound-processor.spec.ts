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
  listPendingGroupMessages: vi.fn(async () => []),
  updateGroupMessageContent: vi.fn(async () => undefined),
  updateGroupMessageSenderName: vi.fn(async () => undefined),
  markGroupMessageEnriched: vi.fn(async () => undefined),
};

/** 群消息日志行快照：enrich_pending 语义与真实表一致，供 pending 富化竞态用例使用。 */
interface LogRow {
  id: number;
  messageId: string;
  msgType: string;
  content: string;
  enrichPending: number;
  isMention: boolean;
}

/** 带内存日志的 messageService 假件：record/listPending/buildContext 都按 enrich_pending 语义联动，
 *  buildGroupContext 复刻真实实现的「遇未富化行即停、@ 消息不注入」，用于验证触发前的补齐时序。 */
function makeLogService(): { svc: Record<string, unknown>; rows: Map<number, LogRow>; calls: string[]; seed: (row: LogRow) => void } {
  const rows = new Map<number, LogRow>();
  const calls: string[] = [];
  let nextId = 0;
  /** 预置日志行（重启遗留等场景），并把自增计数推到该行之后：
   *  日志行 ID 顺序即到达顺序，早到的行 ID 必须小于后续 record 的行。 */
  const seed = (row: LogRow): void => {
    rows.set(row.id, row);
    nextId = Math.max(nextId, row.id);
  };
  const svc = {
    claimInboundMessage: vi.fn(async () => true),
    releaseInboundMessage: vi.fn(async () => undefined),
    completeInboundMessage: vi.fn(async () => undefined),
    recordGroupMessage: vi.fn(async (_accountId: string, event: FeishuNormalizedMessage, isMention: boolean, options?: { enrichPending?: boolean }) => {
      nextId += 1;
      rows.set(nextId, {
        id: nextId, messageId: event.messageId!, msgType: event.messageType, content: event.text,
        enrichPending: options?.enrichPending ? 1 : 0, isMention,
      });
      calls.push(`record:${event.messageId}`);
      return nextId;
    }),
    listPendingGroupMessages: vi.fn(async () => [...rows.values()]
      .filter((row) => row.enrichPending === 1)
      .sort((a, b) => a.id - b.id)
      .map((row) => ({ id: row.id, messageId: row.messageId, msgType: row.msgType }))),
    buildGroupContext: vi.fn(async () => {
      calls.push('context');
      const lines: string[] = [];
      for (const row of [...rows.values()].sort((a, b) => a.id - b.id)) {
        if (row.enrichPending === 1) break;
        if (row.isMention) continue;
        lines.push(`${row.messageId}:${row.content}`);
      }
      return { conversation: {} as never, messages: [], prompt: lines.join('\n') };
    }),
    updateGroupMessageContent: vi.fn(async (id: number, content: string) => {
      const row = rows.get(id);
      if (row != null) {
        row.content = content;
        row.enrichPending = 0;
      }
      calls.push(`update:${id}`);
    }),
    updateGroupMessageSenderName: vi.fn(async () => undefined),
    markGroupMessageEnriched: vi.fn(async (id: number) => {
      const row = rows.get(id);
      if (row != null) row.enrichPending = 0;
      calls.push(`mark:${id}`);
    }),
  };
  return { svc, rows, calls, seed };
}

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
      // 本用例只验证入库保序，不验证富化竞态（见下方 flush 用例）。
      listPendingGroupMessages: vi.fn(async () => []),
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

  it('flushes a pending group merge_forward before building context when a trigger arrives mid-enrichment', async () => {
    // 回归（线上事故）：用户先合并转发聊天记录、马上 @ 机器人。旧逻辑在触发读上下文时，
    // buildGroupContext 会在 enrich_pending 行处截断，本轮 prompt 完全拿不到转发摘录——
    // 而用户往往不会有下一轮触发来补，Agent 只能回复「看不到转发的内容」。
    const excerpt = '【合并转发，共 2 条】\n[2026-10-10 10:30] 张三：自动生成的限流具体是哪…';
    let releaseExpand!: (value: string) => void;
    const expandGate = new Promise<string>((resolve) => { releaseExpand = resolve; });
    const expandMergeForward = vi.fn(() => expandGate);
    const { svc, calls } = makeLogService();
    const onMessage = vi.fn(async (ctx: FeishuInboundContext) => ({ text: ctx.groupContext ?? '' }));
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService: svc as never,
      authorizeSender: async () => true,
      expandMergeForward,
      resolveMergeWorkspace: async () => '/ws/oc_group',
    });
    // 合并转发先到：落 pending 行，后台富化启动后被展开接口挡住。
    await processor.process('1', makeEvent({
      messageId: 'om_merge', messageType: 'merge_forward', text: 'Merged and Forwarded Message', isBotMentioned: false,
    }));
    await vi.waitFor(() => expect(expandMergeForward).toHaveBeenCalledOnce());
    // 用户马上 @ 机器人：触发必须等富化完成再读上下文。
    const triggerDone = processor.process('1', makeEvent({
      messageId: 'om_ment', text: '@bot 你帮我看下这个问题是否存在', isBotMentioned: true,
    }));
    await vi.waitFor(() => expect(svc.listPendingGroupMessages).toHaveBeenCalled());
    expect(svc.buildGroupContext).not.toHaveBeenCalled();
    expect(onMessage).not.toHaveBeenCalled();
    releaseExpand(excerpt);
    await triggerDone;
    // 展开只发生一次：flush 等待在飞行任务，不重复调展开接口。
    expect(expandMergeForward).toHaveBeenCalledOnce();
    // 富化回写先于读上下文，本轮 prompt 带上了转发摘录。
    expect(calls.indexOf('context')).toBeGreaterThan(calls.findIndex((call) => call.startsWith('update:')));
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      groupContext: expect.stringContaining(excerpt),
    }));
  });

  it('expands a stuck pending merge_forward row when no enrichment is in flight', async () => {
    // 后台富化从未启动（进程重启遗留等）时，行会一直挂在 enrich_pending 上，
    // 旧逻辑同样在这行截断；现在触发前就地展开，内容本轮即可见。
    const excerpt = '【合并转发，共 1 条】\n[2026-10-10 10:30] 张三：重启前转发的记录';
    const { svc, rows, calls, seed } = makeLogService();
    seed({
      id: 1, messageId: 'om_stuck', msgType: 'merge_forward',
      content: 'Merged and Forwarded Message', enrichPending: 1, isMention: false,
    });
    const expandMergeForward = vi.fn(async () => excerpt);
    const onMessage = vi.fn(async (ctx: FeishuInboundContext) => ({ text: ctx.groupContext ?? '' }));
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService: svc as never,
      authorizeSender: async () => true,
      expandMergeForward,
      resolveMergeWorkspace: async () => '/ws/oc_group',
    });
    await processor.process('1', makeEvent({ messageId: 'om_ment', text: '@bot 继续', isBotMentioned: true }));
    expect(expandMergeForward).toHaveBeenCalledWith('1', 'om_stuck', '/ws/oc_group');
    expect(svc.updateGroupMessageContent).toHaveBeenCalledWith(1, excerpt);
    expect(svc.markGroupMessageEnriched).toHaveBeenCalledWith(1);
    expect(calls.indexOf('context')).toBeGreaterThan(calls.indexOf('update:1'));
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      groupContext: expect.stringContaining(excerpt),
    }));
  });

  it('leaves a pending image row without in-flight enrichment to the lazy placeholder path', async () => {
    // 图片/文件/卡片的富化输入（imageKey/fileKey/事件 content）不在日志行里，无在飞行任务时
    // 不能重建：维持占位由 Agent 经 feishu_download_file 懒加载兜底，也不提前清 enrich_pending。
    const { svc, rows, seed } = makeLogService();
    seed({
      id: 1, messageId: 'om_img', msgType: 'image', content: '[图片 msg=om_img]', enrichPending: 1, isMention: false,
    });
    const downloadGroupImage = vi.fn(async () => '/ws/img.png');
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService: svc as never,
      authorizeSender: async () => true,
      downloadGroupImage,
    });
    await processor.process('1', makeEvent({ messageId: 'om_ment', text: '@bot 看图', isBotMentioned: true }));
    expect(downloadGroupImage).not.toHaveBeenCalled();
    expect(svc.markGroupMessageEnriched).not.toHaveBeenCalledWith(1);
    expect(rows.get(1)!.enrichPending).toBe(1);
  });

  it('waits for an in-flight image enrichment before building context', async () => {
    // 同一竞态的图片变体：图片先到、后台下载中，@ 触发读到上下文前先等下载完成，
    // 占位行才不会把后续内容截断在 prompt 之外。
    let releaseDownload!: () => void;
    const downloadGate = new Promise<void>((resolve) => { releaseDownload = resolve; });
    const { svc, calls } = makeLogService();
    const onMessage = vi.fn(async (ctx: FeishuInboundContext) => ({ text: ctx.groupContext ?? '' }));
    const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
      messageService: svc as never,
      authorizeSender: async () => true,
      downloadGroupImage: async () => {
        await downloadGate;
        return '/ws/feishu-image-om_img.png';
      },
    });
    await processor.process('1', makeEvent({
      messageId: 'om_img', messageType: 'image', imageKey: 'k', text: '', isBotMentioned: false,
    }));
    const triggerDone = processor.process('1', makeEvent({ messageId: 'om_ment', text: '@bot 看图', isBotMentioned: true }));
    await vi.waitFor(() => expect(svc.listPendingGroupMessages).toHaveBeenCalled());
    expect(svc.buildGroupContext).not.toHaveBeenCalled();
    releaseDownload();
    await triggerDone;
    expect(svc.updateGroupMessageContent).toHaveBeenCalledWith(1, '[图片已保存: @{/ws/feishu-image-om_img.png}@]');
    expect(calls.indexOf('context')).toBeGreaterThan(calls.indexOf('update:1'));
    expect(onMessage).toHaveBeenCalledWith(expect.objectContaining({
      groupContext: expect.stringContaining('@{/ws/feishu-image-om_img.png}@'),
    }));
  });

  it('keeps the trigger unblocked when a stuck merge_forward fails to expand during flush', async () => {
    // 补齐失败不能拖死触发：保留占位文本、放行水位线，行为与后台富化失败一致。
    const { svc, rows, seed } = makeLogService();
    seed({
      id: 1, messageId: 'om_stuck_fail', msgType: 'merge_forward',
      content: 'Merged and Forwarded Message', enrichPending: 1, isMention: false,
    });
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const onMessage = vi.fn(async () => ({ text: 'r' }));
      const processor = new FeishuInboundProcessor(makeHandler(onMessage), {
        messageService: svc as never,
        authorizeSender: async () => true,
        expandMergeForward: async () => null,
      });
      await processor.process('1', makeEvent({ messageId: 'om_ment', text: '@bot 继续', isBotMentioned: true }));
      expect(onMessage).toHaveBeenCalledOnce();
      expect(svc.updateGroupMessageContent).not.toHaveBeenCalled();
      expect(svc.markGroupMessageEnriched).toHaveBeenCalledWith(1);
    } finally {
      consoleWarn.mockRestore();
    }
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

describe('FeishuInboundProcessor 合并窗口', () => {
  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  function windowedProcessor(
    onMessage: (ctx: FeishuInboundContext) => Promise<FeishuReply | null>,
    options: ConstructorParameters<typeof FeishuInboundProcessor>[1] = {},
  ): FeishuInboundProcessor {
    // 群消息必须挂 messageService（与现状一致：无 messageService 的群消息不触发）；
    // 未显式注入时给一份内存日志假件。
    const fallbackLog = options.messageService == null ? makeLogService() : null;
    return new FeishuInboundProcessor(makeHandler(onMessage), {
      mergeWindowMs: 30, authorizeSender: async () => true,
      ...(fallbackLog != null ? { messageService: fallbackLog.svc as never } : {}),
      ...options,
    });
  }

  it('两条文本窗口期内合并为一次触发，正文按到达序拼接，两条 claim 均 complete', async () => {
    const { svc } = makeLogService();
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const processor = windowedProcessor(onMessage, { messageService: svc as never });
    await processor.process('1', makeEvent({ messageId: 'om_a', text: '看看这个', isBotMentioned: true }));
    await processor.process('1', makeEvent({ messageId: 'om_b', text: '帮我总结', isBotMentioned: true }));
    await wait(120);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].text).toBe('看看这个\n\n帮我总结');
    expect(svc.completeInboundMessage).toHaveBeenCalledWith('1', 'om_a');
    expect(svc.completeInboundMessage).toHaveBeenCalledWith('1', 'om_b');
  });

  it('单条消息窗口到点后单次触发', async () => {
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const processor = windowedProcessor(onMessage);
    await processor.process('1', makeEvent({ messageId: 'om_solo', isBotMentioned: true }));
    await wait(120);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].messageId).toBe('om_solo');
  });

  it('图片消息到达即冲刷窗口，任务先跑，图片单独触发', async () => {
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const processor = windowedProcessor(onMessage);
    await processor.process('1', makeEvent({ messageId: 'om_t', text: '看这张', isBotMentioned: true }));
    await processor.process('1', makeEvent({ messageId: 'om_img', messageType: 'image', text: '[图片]', isBotMentioned: true }));
    // 豁免路径同步等到批次触发返回后才触发自己，定时器尚未到点。
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage.mock.calls[0][0].text).toBe('看这张');
    expect(onMessage.mock.calls[1][0].messageId).toBe('om_img');
    await wait(120);
    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it('`---` 到达即冲刷窗口后单独生效', async () => {
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const processor = windowedProcessor(onMessage);
    await processor.process('1', makeEvent({ messageId: 'om_t', chatType: 'p2p', text: '继续', isBotMentioned: true }));
    await processor.process('1', makeEvent({ messageId: 'om_cmd', chatType: 'p2p', text: '---', isBotMentioned: true }));
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage.mock.calls[1][0].text).toBe('---');
  });

  it('p2p 引用切换消息不入窗，单独触发', async () => {
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const processor = windowedProcessor(onMessage);
    await processor.process('1', makeEvent({ messageId: 'om_t', chatType: 'p2p', text: '第一句', isBotMentioned: true }));
    await processor.process('1', makeEvent({ messageId: 'om_q', chatType: 'p2p', text: '引用这条', parentId: 'om_parent', isBotMentioned: true }));
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage.mock.calls[0][0].text).toBe('第一句');
    expect(onMessage.mock.calls[1][0].messageId).toBe('om_q');
  });

  it('带内嵌图片的 post 豁免出窗，单独触发', async () => {
    // 同时守护「先批后豁免」顺序：post 自己的日志行（待富化）到达序在批次之后，
    // 批次的触发不能等它——否则豁免消息的后台富化会把批次挂住、让 post 反超。
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const processor = windowedProcessor(onMessage);
    await processor.process('1', makeEvent({ messageId: 'om_t', text: '看这条', isBotMentioned: true }));
    await processor.process('1', makeEvent({ messageId: 'om_post', messageType: 'post', text: '图文', imageKeys: ['img_x'], isBotMentioned: true }));
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage.mock.calls[1][0].messageId).toBe('om_post');
    expect(onMessage.mock.calls[1][0].imageKeys).toEqual(['img_x']);
  });

  it('不同发送者同群窗口期内仍是两次触发', async () => {
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const processor = windowedProcessor(onMessage);
    await processor.process('1', makeEvent({ messageId: 'om_u1', senderId: 'ou_1', text: '甲说', isBotMentioned: true }));
    await processor.process('1', makeEvent({ messageId: 'om_u2', senderId: 'ou_2', text: '乙说', isBotMentioned: true }));
    await wait(120);
    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it('群聊两条 @ 合并：两条群日志 + 一次触发，groupContext 由末条消息读出', async () => {
    const { svc, calls } = makeLogService();
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const processor = windowedProcessor(onMessage, { messageService: svc as never });
    await processor.process('1', makeEvent({ messageId: 'om_g1', text: '第一条', isBotMentioned: true }));
    await processor.process('1', makeEvent({ messageId: 'om_g2', text: '第二条', isBotMentioned: true }));
    await wait(120);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.startsWith('record:'))).toHaveLength(2);
    // 合并触发只读一次群上下文（用末条 messageId），且 @ 行按既有语义不注入。
    expect(calls.filter((c) => c === 'context')).toHaveLength(1);
    expect(onMessage.mock.calls[0][0].text).toBe('第一条\n\n第二条');
  });

  it('合并转发 + 附言：慢展开不乱序，摘录与附言在同一条用户消息内（到达序）', async () => {
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const processor = windowedProcessor(onMessage, {
      mergeWindowMs: 120,
      expandMergeForward: async () => { await wait(60); return '【转发摘录】'; },
    });
    const chatType = 'p2p' as const;
    // 转发先到达（process 入口先拿到 arrivalSeq），但其展开是慢操作、附言先 submit。
    const p1 = processor.process('1', makeEvent({ messageId: 'om_fwd', chatType, messageType: 'merge_forward', text: '[合并转发]', isBotMentioned: true }));
    const p2 = processor.process('1', makeEvent({ messageId: 'om_note', chatType, text: '看看这个', isBotMentioned: true }));
    await Promise.all([p1, p2]);
    await wait(250);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].text).toBe('【转发摘录】\n\n看看这个');
    expect(onMessage.mock.calls[0][0].messageId).toBe('om_fwd');
  });

  it('窗口期同 messageId 重投被 claim 去重，不入窗', async () => {
    const { svc } = makeLogService();
    svc.claimInboundMessage = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const processor = windowedProcessor(onMessage, { messageService: svc as never });
    await processor.process('1', makeEvent({ messageId: 'om_dup', text: '一次', isBotMentioned: true }));
    await processor.process('1', makeEvent({ messageId: 'om_dup', text: '重投', isBotMentioned: true }));
    await wait(120);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].text).toBe('一次');
  });

  it('豁免消息只等在途批次触发启动，不被其执行阻塞', async () => {
    let release = (): void => undefined;
    const onMessage = vi.fn(async (ctx: FeishuInboundContext) => {
      if (ctx.messageId === 'om_slow') {
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return { text: 'r' };
    });
    const processor = windowedProcessor(onMessage);
    await processor.process('1', makeEvent({ messageId: 'om_slow', text: '慢任务', isBotMentioned: true }));
    await processor.process('1', makeEvent({ messageId: 'om_img', messageType: 'image', text: '[图片]', isBotMentioned: true }));
    // 批次 [om_slow] 的执行一直挂起，图片已在其启动后立即单独触发。
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage.mock.calls[1][0].messageId).toBe('om_img');
    release();
    await wait(20);
  });

  it('合并触发抛错时批内 claim 全部 release', async () => {
    const { svc } = makeLogService();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const processor = windowedProcessor(async () => { throw new Error('boom'); }, { messageService: svc as never });
    await processor.process('1', makeEvent({ messageId: 'om_e1', text: '一', isBotMentioned: true }));
    await processor.process('1', makeEvent({ messageId: 'om_e2', text: '二', isBotMentioned: true }));
    await wait(120);
    expect(svc.releaseInboundMessage).toHaveBeenCalledWith('1', 'om_e1');
    expect(svc.releaseInboundMessage).toHaveBeenCalledWith('1', 'om_e2');
    errorSpy.mockRestore();
  });

  it('bypassWindow（绑定后补投）不经过窗口，立即单条触发', async () => {
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const processor = windowedProcessor(onMessage);
    await processor.process('1', makeEvent({ messageId: 'om_replay', text: '补投', isBotMentioned: true }), true, { bypassWindow: true });
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].messageId).toBe('om_replay');
  });

  it('flushAll 冲刷在途批次', async () => {
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const processor = windowedProcessor(onMessage);
    await processor.process('1', makeEvent({ messageId: 'om_f1', text: '待冲刷', isBotMentioned: true }));
    // flushAll 只保证批次 flush 启动（onMessage 在其内部 await 之后），给一点时间让触发完成。
    await processor.flushAll();
    await wait(50);
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage.mock.calls[0][0].text).toBe('待冲刷');
    await wait(120);
    expect(onMessage).toHaveBeenCalledTimes(1);
  });

  it('windowMs=0 时立即单条触发，行为与加窗前一致', async () => {
    const onMessage = vi.fn(async () => ({ text: 'r' }));
    const processor = windowedProcessor(onMessage, { mergeWindowMs: 0 });
    await processor.process('1', makeEvent({ messageId: 'om_z1', text: '甲', isBotMentioned: true }));
    await processor.process('1', makeEvent({ messageId: 'om_z2', text: '乙', isBotMentioned: true }));
    // submit 已 await 到 onFlush 返回：无需等待定时器即两次触发、无合并。
    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage.mock.calls[0][0].text).toBe('甲');
    expect(onMessage.mock.calls[1][0].text).toBe('乙');
  });
});
