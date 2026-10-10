import { describe, expect, it, vi } from 'vitest';
import { InboundProcessor } from './inbound-processor.js';
import type { WeixinInboundHandler } from './types.js';
import type { WeixinMediaService } from './media.service.js';
import type { ContextTokenRepository } from './context-token.repository.js';
import type { WeixinSendService } from './send.service.js';
import type { WeixinVoiceReplyService } from './voice-reply.service.js';

describe('InboundProcessor', () => {
  const inboundHandler = { onMessage: vi.fn(), authorizeDirectMessage: vi.fn() };
  const weixinMediaService = { downloadFile: vi.fn(), downloadImage: vi.fn() };
  const processor = new InboundProcessor(
    inboundHandler as unknown as WeixinInboundHandler,
    { saveOrUpdate: vi.fn() } as unknown as ContextTokenRepository,
    { sendText: vi.fn() } as unknown as WeixinSendService,
    weixinMediaService as unknown as WeixinMediaService,
    { sendVoiceReply: vi.fn() } as unknown as WeixinVoiceReplyService,
  );

  function baseMessage(): Record<string, unknown> {
    return { from_user_id: 'wx-user-1', context_token: 'token-1', item_list: [] as unknown[] };
  }

  function addFileItem(message: Record<string, unknown>, fileName: string): void {
    const itemList = message.item_list as unknown[];
    itemList.push({
      type: 4,
      file_item: { file_name: fileName, media: { encrypt_query_param: 'enc-param' } },
    });
  }

  it('fileMessage_triggersHandlerWithDownloadedFile', async () => {
    inboundHandler.onMessage.mockResolvedValue({ text: '' });
    const message = baseMessage();
    addFileItem(message, '报告.pdf');
    weixinMediaService.downloadFile.mockResolvedValue({
      fileName: '报告.pdf', bytes: Buffer.from('pdf-content'), mimeType: 'application/pdf',
    });
    await processor.processInboundMessage('acc-1', message);
    expect(inboundHandler.onMessage).toHaveBeenCalled();
    const ctx = inboundHandler.onMessage.mock.calls[0][0];
    expect(ctx.files).toHaveLength(1);
    expect(ctx.files[0].fileName).toBe('报告.pdf');
    expect(ctx.files[0].bytes.toString()).toBe('pdf-content');
  });

  it('textAndFileMessage_triggersHandlerWithFileAndBody', async () => {
    inboundHandler.onMessage.mockResolvedValue({ text: '' });
    const message = baseMessage();
    (message.item_list as unknown[]).push({ type: 1, text_item: { text: '帮我看看' } });
    addFileItem(message, 'a.pdf');
    weixinMediaService.downloadFile.mockResolvedValue({
      fileName: 'a.pdf', bytes: Buffer.from('bytes'), mimeType: 'application/pdf',
    });
    await processor.processInboundMessage('acc-1', message);
    const ctx = inboundHandler.onMessage.mock.calls.at(-1)![0];
    expect(ctx.body).toBe('帮我看看');
    expect(ctx.files).toHaveLength(1);
  });

  it('emptyMessage_ignoredWithoutHandler', async () => {
    inboundHandler.onMessage.mockClear();
    await processor.processInboundMessage('acc-1', baseMessage());
    expect(inboundHandler.onMessage).not.toHaveBeenCalled();
  });

  it('imageMessage_triggersHandlerWithImageFileAndDataUri', async () => {
    inboundHandler.onMessage.mockResolvedValue({ text: '' });
    const message = baseMessage();
    (message.item_list as unknown[]).push({ type: 2, image_item: { media: { encrypt_query_param: 'img-q' } } });
    weixinMediaService.downloadImage.mockResolvedValue({
      path: '/tmp/weixin-media/abc.jpg',
      bytes: Buffer.from('jpeg-bytes'),
      mimeType: 'image/jpeg',
      dataUri: 'data:image/jpeg;base64,anBlZy1ieXRlcw==',
    });
    await processor.processInboundMessage('acc-1', message);
    const ctx = inboundHandler.onMessage.mock.calls.at(-1)![0];
    expect(ctx.files).toHaveLength(1);
    expect(ctx.files[0].fileName).toMatch(/^image-[0-9a-f-]+\.jpg$/);
    expect(ctx.files[0].mimeType).toBe('image/jpeg');
    expect(ctx.files[0].bytes.toString()).toBe('jpeg-bytes');
    expect(ctx.imageDataUris).toEqual(['data:image/jpeg;base64,anBlZy1ieXRlcw==']);
    expect(ctx.imageFileNames).toEqual([ctx.files[0].fileName]);
  });

  it('fileDownloadFailure_notTreatedAsEmpty', async () => {
    inboundHandler.onMessage.mockResolvedValue({ text: '' });
    const message = baseMessage();
    addFileItem(message, 'broken.pdf');
    weixinMediaService.downloadFile.mockResolvedValue(null);
    await processor.processInboundMessage('acc-1', message);
    const ctx = inboundHandler.onMessage.mock.calls.at(-1)![0];
    expect(ctx.files).toHaveLength(0);
    expect(ctx.fileDownloadErrors).toEqual(['broken.pdf']);
  });

  it('partialFileDownloadFailure_successAndFailedBothPassed', async () => {
    inboundHandler.onMessage.mockResolvedValue({ text: '' });
    const message = baseMessage();
    addFileItem(message, 'ok.pdf');
    addFileItem(message, 'bad.pdf');
    weixinMediaService.downloadFile.mockImplementation(async (fileItem: Record<string, unknown>) => {
      const name = String(fileItem.file_name);
      if (name === 'bad.pdf') return null;
      return { fileName: name, bytes: Buffer.from('bytes'), mimeType: 'application/pdf' };
    });
    await processor.processInboundMessage('acc-1', message);
    const ctx = inboundHandler.onMessage.mock.calls.at(-1)![0];
    expect(ctx.files).toHaveLength(1);
    expect(ctx.files[0].fileName).toBe('ok.pdf');
    expect(ctx.fileDownloadErrors).toEqual(['bad.pdf']);
  });

  it('fileOnlyMessage_notTreatedAsEmpty', async () => {
    inboundHandler.onMessage.mockResolvedValue({ text: '' });
    inboundHandler.onMessage.mockClear();
    const message = baseMessage();
    addFileItem(message, 'only.pdf');
    weixinMediaService.downloadFile.mockResolvedValue({
      fileName: 'only.pdf', bytes: Buffer.from('x'), mimeType: 'application/pdf',
    });
    await processor.processInboundMessage('acc-1', message);
    expect(inboundHandler.onMessage).toHaveBeenCalled();
  });

  it('replySendFails_sendsFallbackNoticeSoUserIsNotLeftSilent', async () => {
    inboundHandler.onMessage.mockResolvedValue({ text: '这是回答' });
    const sendText = vi.fn(async (_a: string, _b: string, _t: string) => false);
    const failingProcessor = new InboundProcessor(
      inboundHandler as unknown as WeixinInboundHandler,
      { saveOrUpdate: vi.fn() } as unknown as ContextTokenRepository,
      { sendText } as unknown as WeixinSendService,
      weixinMediaService as unknown as WeixinMediaService,
      { sendVoiceReply: vi.fn(async () => false) } as unknown as WeixinVoiceReplyService,
    );
    const message = baseMessage();
    (message.item_list as unknown[]).push({ type: 1, text_item: { text: '在吗' } });
    await failingProcessor.processInboundMessage('acc-1', message);
    // 第一次是原始回复，第二次是降级提示：用户侧至少收到一条可感知消息
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(String(sendText.mock.calls[1]?.[2])).toContain('发送失败');
  });

  it('replySendFails_doesNotSendVoiceReply', async () => {
    inboundHandler.onMessage.mockResolvedValue({ text: '这是回答' });
    const sendText = vi.fn(async (_a: string, _b: string, _t: string) => false);
    const sendVoiceReply = vi.fn(async () => false);
    const failingProcessor = new InboundProcessor(
      inboundHandler as unknown as WeixinInboundHandler,
      { saveOrUpdate: vi.fn() } as unknown as ContextTokenRepository,
      { sendText } as unknown as WeixinSendService,
      weixinMediaService as unknown as WeixinMediaService,
      { sendVoiceReply } as unknown as WeixinVoiceReplyService,
    );
    const message = baseMessage();
    (message.item_list as unknown[]).push({ type: 1, text_item: { text: '在吗' } });
    await failingProcessor.processInboundMessage('acc-1', message);
    expect(sendVoiceReply).not.toHaveBeenCalled();
  });

  it('replySendSucceeds_noFallbackNotice', async () => {
    inboundHandler.onMessage.mockResolvedValue({ text: '这是回答' });
    const sendText = vi.fn(async (_a: string, _b: string, _t: string) => true);
    const okProcessor = new InboundProcessor(
      inboundHandler as unknown as WeixinInboundHandler,
      { saveOrUpdate: vi.fn() } as unknown as ContextTokenRepository,
      { sendText } as unknown as WeixinSendService,
      weixinMediaService as unknown as WeixinMediaService,
      { sendVoiceReply: vi.fn(async () => false) } as unknown as WeixinVoiceReplyService,
    );
    const message = baseMessage();
    (message.item_list as unknown[]).push({ type: 1, text_item: { text: '在吗' } });
    await okProcessor.processInboundMessage('acc-1', message);
    expect(sendText).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith('acc-1', 'wx-user-1', '这是回答');
  });

  it('微信与降级提示都失败_把回复原文推送到用户配置的 webhook', async () => {
    inboundHandler.onMessage.mockResolvedValue({ text: '完整回答内容' });
    // 微信侧全挂：原始回复与降级提示都发不出去（24h 窗口过期时的真实表现）
    const sendText = vi.fn(async (_a: string, _b: string, _t: string) => false);
    const sendFallback = vi.fn(async () => true);
    const accountRepository = { findByAccountId: vi.fn(async () => ({ userId: 42 })) };
    const failingProcessor = new InboundProcessor(
      inboundHandler as unknown as WeixinInboundHandler,
      { saveOrUpdate: vi.fn() } as unknown as ContextTokenRepository,
      { sendText } as unknown as WeixinSendService,
      weixinMediaService as unknown as WeixinMediaService,
      { sendVoiceReply: vi.fn(async () => false) } as unknown as WeixinVoiceReplyService,
      undefined,
      { sendFallback } as never,
      accountRepository as never,
    );
    const message = baseMessage();
    (message.item_list as unknown[]).push({ type: 1, text_item: { text: '在吗' } });
    await failingProcessor.processInboundMessage('acc-1', message);
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendFallback).toHaveBeenCalledWith(42, '完整回答内容');
  });

  it('降级提示送达_不再推 webhook（避免用户收到重复内容）', async () => {
    inboundHandler.onMessage.mockResolvedValue({ text: '完整回答内容' });
    // 第一次（原始回复）失败，第二次（降级提示）成功
    const sendText = vi.fn(async (_a: string, _b: string, _t: string) => sendText.mock.calls.length === 1 ? false : true);
    const sendFallback = vi.fn(async () => true);
    const processorWithFallback = new InboundProcessor(
      inboundHandler as unknown as WeixinInboundHandler,
      { saveOrUpdate: vi.fn() } as unknown as ContextTokenRepository,
      { sendText } as unknown as WeixinSendService,
      weixinMediaService as unknown as WeixinMediaService,
      { sendVoiceReply: vi.fn(async () => false) } as unknown as WeixinVoiceReplyService,
      undefined,
      { sendFallback } as never,
      { findByAccountId: vi.fn(async () => ({ userId: 42 })) } as never,
    );
    const message = baseMessage();
    (message.item_list as unknown[]).push({ type: 1, text_item: { text: '在吗' } });
    await processorWithFallback.processInboundMessage('acc-1', message);
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(sendFallback).not.toHaveBeenCalled();
  });

  it('缺少 contextToken 时降级提示失败也走 webhook', async () => {
    inboundHandler.onMessage.mockResolvedValue({ text: '无 token 的回答' });
    const sendText = vi.fn(async (_a: string, _b: string, _t: string) => false);
    const sendFallback = vi.fn(async () => true);
    const noTokenProcessor = new InboundProcessor(
      inboundHandler as unknown as WeixinInboundHandler,
      { saveOrUpdate: vi.fn() } as unknown as ContextTokenRepository,
      { sendText } as unknown as WeixinSendService,
      weixinMediaService as unknown as WeixinMediaService,
      { sendVoiceReply: vi.fn(async () => false) } as unknown as WeixinVoiceReplyService,
      undefined,
      { sendFallback } as never,
      { findByAccountId: vi.fn(async () => ({ userId: 7 })) } as never,
    );
    const message = baseMessage();
    delete message.context_token;
    (message.item_list as unknown[]).push({ type: 1, text_item: { text: '在吗' } });
    await noTokenProcessor.processInboundMessage('acc-1', message);
    expect(sendFallback).toHaveBeenCalledWith(7, '无 token 的回答');
  });
});
