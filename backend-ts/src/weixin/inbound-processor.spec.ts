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
});
