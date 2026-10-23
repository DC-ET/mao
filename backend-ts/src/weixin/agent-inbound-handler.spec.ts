import { randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { STORE_COMPRESS_THRESHOLD_BYTES, STORE_TARGET_BYTES } from '../harness/tool/prompt-image-resizer.js';
import { AgentWeixinInboundHandler, appendDownloadErrorNotice } from './agent-inbound-handler.js';
import type { ContentPart } from '../domain/types.js';
import type { WeixinInboundMessageContext } from './types.js';

describe('AgentWeixinInboundHandler', () => {
  const handler = new AgentWeixinInboundHandler();

  it('buildMessageContent_textOnly', async () => {
    const ctx: WeixinInboundMessageContext = { accountId: 'a', body: '你好' };
    expect(await handler.buildMessageContent(ctx, [], [], null)).toBe('你好');
  });

  it('buildMessageContent_imageWithDefaultPrompt', async () => {
    const ctx: WeixinInboundMessageContext = {
      accountId: 'a', body: '', imageDataUris: ['data:image/png;base64,abc'],
    };
    const content = await handler.buildMessageContent(ctx, [], [], null) as ContentPart[];
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe('text');
    expect(content[0].text).toBe('请查看这张图片');
    expect(content[1].type).toBe('image_url');
    expect(content[1].imageUrl!.url.startsWith('data:image/png')).toBe(true);
  });

  it('buildMessageContent_imageWithPathHint', async () => {
    const ctx: WeixinInboundMessageContext = {
      accountId: 'a', body: '', imageDataUris: ['data:image/png;base64,abc'],
    };
    const content = await handler.buildMessageContent(ctx, [], ['/ws/weixin-files/2026-08-06/a.png'], '/ws') as ContentPart[];
    expect(content).toHaveLength(2);
    expect(content[0].type).toBe('text');
    expect(content[0].text).toContain('图片已保存到会话工作区');
    expect(content[0].text).toContain('weixin-files/2026-08-06/a.png');
    expect(content[0].text).not.toContain('/ws/weixin-files');
  });

  it('buildMessageContent_textAndImage', async () => {
    const ctx: WeixinInboundMessageContext = {
      accountId: 'a', body: '这是什么', imageDataUris: ['data:image/jpeg;base64,xyz'],
    };
    const parts = await handler.buildMessageContent(ctx, [], [], null) as ContentPart[];
    expect(parts[0].text).toBe('这是什么');
    expect(parts).toHaveLength(2);
  });

  it('buildMessageContent_compressesLargeInboundImages', async () => {
    // 1200x1200 随机噪声 PNG 必然 >1.5MB：入站写入前应压到 ≤1.2MB（消息 data URI），
    // 同时保持图片类型不变（image_url part），不影响图片可见性。
    const source = await sharp(randomBytes(1200 * 1200 * 3), {
      raw: { width: 1200, height: 1200, channels: 3 },
    }).png().toBuffer();
    expect(source.length).toBeGreaterThan(STORE_COMPRESS_THRESHOLD_BYTES);
    const original = `data:image/png;base64,${source.toString('base64')}`;
    const ctx: WeixinInboundMessageContext = { accountId: 'a', body: '', imageDataUris: [original] };
    const parts = await handler.buildMessageContent(ctx, [], [], null) as ContentPart[];
    const url = parts[1].imageUrl!.url;
    const bytes = Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
    expect(bytes.length).toBeLessThanOrEqual(STORE_TARGET_BYTES);
    expect(url).not.toBe(original);
    // 原 data URI 不被修改（落盘/预览仍用原图）
    expect(ctx.imageDataUris![0]).toBe(original);
  });

  it('buildMessageContent_fileOnly_injectsPathMarker', async () => {
    const ctx: WeixinInboundMessageContext = { accountId: 'a', body: '' };
    expect(await handler.buildMessageContent(ctx, ['/ws/weixin-files/2026-08-06/a.pdf'], [], null))
      .toBe('@{/ws/weixin-files/2026-08-06/a.pdf}@');
  });

  it('buildMessageContent_textAndFile_injectsPathMarkerAfterText', async () => {
    const ctx: WeixinInboundMessageContext = { accountId: 'a', body: '帮我看看这个文件' };
    expect(await handler.buildMessageContent(ctx, ['/ws/a.pdf'], [], null)).toBe('帮我看看这个文件\n@{/ws/a.pdf}@');
  });

  it('buildMessageContent_multipleFiles_injectsAllMarkers', async () => {
    const ctx: WeixinInboundMessageContext = { accountId: 'a', body: '' };
    expect(await handler.buildMessageContent(ctx, ['/ws/a.pdf', '/ws/b.docx'], [], null))
      .toBe('@{/ws/a.pdf}@\n@{/ws/b.docx}@');
  });

  it('buildMessageContent_fileAndImage_mixedContentPart', async () => {
    const ctx: WeixinInboundMessageContext = {
      accountId: 'a', body: '看下文件和图片', imageDataUris: ['data:image/png;base64,img'],
    };
    const parts = await handler.buildMessageContent(ctx, ['/ws/a.pdf'], ['/ws/weixin-files/2026-08-06/img.png'], '/ws') as ContentPart[];
    expect(parts).toHaveLength(2);
    expect(parts[0].text).toContain('看下文件和图片');
    expect(parts[0].text).toContain('/ws/a.pdf');
    expect(parts[0].text).toContain('图片已保存到会话工作区');
    expect(parts[0].text).toContain('weixin-files/2026-08-06/img.png');
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
