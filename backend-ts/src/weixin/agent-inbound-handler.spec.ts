import { describe, expect, it } from 'vitest';
import { AgentWeixinInboundHandler, appendDownloadErrorNotice } from './agent-inbound-handler.js';
import type { ContentPart } from '../domain/types.js';
import type { WeixinInboundMessageContext } from './types.js';

describe('AgentWeixinInboundHandler', () => {
  const handler = new AgentWeixinInboundHandler();

  it('buildMessageContent_textOnly', () => {
    const ctx: WeixinInboundMessageContext = { accountId: 'a', body: '你好' };
    expect(handler.buildMessageContent(ctx, [])).toBe('你好');
  });

  it('buildMessageContent_imageWithDefaultPrompt', () => {
    const ctx: WeixinInboundMessageContext = {
      accountId: 'a', body: '', imageDataUris: ['data:image/png;base64,abc'],
    };
    const content = handler.buildMessageContent(ctx, []) as ContentPart[];
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe('text');
    expect(content[0].text).toBe('请查看这张图片');
    expect(content[1].type).toBe('image_url');
    expect(content[1].imageUrl!.url.startsWith('data:image/png')).toBe(true);
  });

  it('buildMessageContent_textAndImage', () => {
    const ctx: WeixinInboundMessageContext = {
      accountId: 'a', body: '这是什么', imageDataUris: ['data:image/jpeg;base64,xyz'],
    };
    const parts = handler.buildMessageContent(ctx, []) as ContentPart[];
    expect(parts[0].text).toBe('这是什么');
    expect(parts).toHaveLength(2);
  });

  it('buildMessageContent_fileOnly_injectsPathMarker', () => {
    const ctx: WeixinInboundMessageContext = { accountId: 'a', body: '' };
    expect(handler.buildMessageContent(ctx, ['/ws/weixin-files/2026-08-06/a.pdf']))
      .toBe('@{/ws/weixin-files/2026-08-06/a.pdf}@');
  });

  it('buildMessageContent_textAndFile_injectsPathMarkerAfterText', () => {
    const ctx: WeixinInboundMessageContext = { accountId: 'a', body: '帮我看看这个文件' };
    expect(handler.buildMessageContent(ctx, ['/ws/a.pdf'])).toBe('帮我看看这个文件\n@{/ws/a.pdf}@');
  });

  it('buildMessageContent_multipleFiles_injectsAllMarkers', () => {
    const ctx: WeixinInboundMessageContext = { accountId: 'a', body: '' };
    expect(handler.buildMessageContent(ctx, ['/ws/a.pdf', '/ws/b.docx']))
      .toBe('@{/ws/a.pdf}@\n@{/ws/b.docx}@');
  });

  it('buildMessageContent_fileAndImage_mixedContentPart', () => {
    const ctx: WeixinInboundMessageContext = {
      accountId: 'a', body: '看下文件和图片', imageDataUris: ['data:image/png;base64,img'],
    };
    const parts = handler.buildMessageContent(ctx, ['/ws/a.pdf']) as ContentPart[];
    expect(parts).toHaveLength(2);
    expect(parts[0].text).toBe('看下文件和图片\n/ws/a.pdf');
    expect(parts[1].type).toBe('image_url');
  });

  it('appendDownloadErrorNotice_withBody', () => {
    expect(appendDownloadErrorNotice('帮我看看', ['bad.pdf']))
      .toBe('帮我看看\n[以下文件接收失败：bad.pdf]');
  });

  it('appendDownloadErrorNotice_emptyBody', () => {
    expect(appendDownloadErrorNotice('', ['a.pdf', 'b.docx']))
      .toBe('[以下文件接收失败：a.pdf、b.docx]');
  });
});
