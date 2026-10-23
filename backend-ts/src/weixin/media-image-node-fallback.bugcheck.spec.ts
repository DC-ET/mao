import { afterAll, describe, expect, it, vi } from 'vitest';
import { rmSync } from 'node:fs';
import { encryptAes128Ecb } from '../crypto/aes-gcm.js';
import { WeixinMediaService } from './media.service.js';
import { DEFAULT_WEIXIN_BOT_CONFIG } from './types.js';
import type { WeixinHttpClient, WeixinHttpResponse } from './weixin-http.js';

/**
 * 回归（微信入站图片下载）：`WeixinMediaService.downloadImage` 自己内联了一份
 * 「选媒体节点」的口径：
 *
 *   let media = imageItem.media;
 *   if (media == null) media = imageItem.thumb_media;   // 只看节点是否存在
 *
 * 而同仓共享的 `resolveMediaNode`（weixin/media-crypto.ts，文件下载路径 downloadFile
 * 用的就是它）口径是「取第一个带有效 encrypt_query_param 的节点」——media 节点存在
 * 但字段不完整时继续看 thumb_media。
 *
 * 后果：图片消息的 media 节点存在却没带 encrypt_query_param（thumb_media 带了）时，
 * 图片路径不会回退，直接判「图片消息缺少 encrypt_query_param」返回 null，
 * Agent 收不到这张图；文件路径（downloadFile）在同样载荷下却能正常下载。
 * 另外 AES key 也是按同一个「先选中」的节点取的（resolveAesKey(imageItem, media)），
 * 回退缺失时连密钥都对不上。
 */

// downloadImage 会往 tmpdir()/weixin-media 写文件：重定向到本文件专属目录，结束后清理。
const { mediaTmpRoot } = vi.hoisted(() => ({
  mediaTmpRoot: `/tmp/weixin-media-bugcheck-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
}));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, tmpdir: () => mediaTmpRoot };
});

afterAll(() => {
  rmSync(mediaTmpRoot, { recursive: true, force: true });
});

const KEY = Buffer.from('0123456789abcdef', 'ascii');
const AES_KEY_B64 = KEY.toString('base64');

function jpegBytes(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]);
}

function cipherClient(body: Buffer): { client: WeixinHttpClient; urls: string[] } {
  const urls: string[] = [];
  const client: WeixinHttpClient = {
    request: vi.fn(async (url: string) => {
      urls.push(url);
      return { status: 200, headers: {}, body, header: () => undefined } as WeixinHttpResponse;
    }),
  };
  return { client, urls };
}

describe('微信入站图片下载：媒体节点选取须与文件路径同口径（可回退 thumb_media）', () => {
  it('对照组：media 节点自带 encrypt_query_param 时按 media 下载', async () => {
    const plain = jpegBytes();
    const { client, urls } = cipherClient(encryptAes128Ecb(plain, KEY));
    const svc = new WeixinMediaService(
      { ...DEFAULT_WEIXIN_BOT_CONFIG, cdnBaseUrl: 'https://cdn.example/c2c/' },
      { image: client, file: client },
    );
    const result = await svc.downloadImage({
      media: { encrypt_query_param: 'media-param', aes_key: AES_KEY_B64 },
    });
    expect(result).not.toBeNull();
    expect(result!.bytes.equals(plain)).toBe(true);
    expect(urls.some((u) => u.includes('media-param'))).toBe(true);
  });

  it('回归：media 节点缺 encrypt_query_param、thumb_media 有时，应回退下载缩略图', async () => {
    const plain = jpegBytes();
    const { client, urls } = cipherClient(encryptAes128Ecb(plain, KEY));
    const svc = new WeixinMediaService(
      { ...DEFAULT_WEIXIN_BOT_CONFIG, cdnBaseUrl: 'https://cdn.example/c2c/' },
      { image: client, file: client },
    );
    const result = await svc.downloadImage({
      media: { file_name: 'x.png' },
      thumb_media: { encrypt_query_param: 'thumb-param', aes_key: AES_KEY_B64 },
    });
    // 期望：不判失败，用 thumb_media 的下载参数 + 同一节点的 AES key 解密
    expect(result).not.toBeNull();
    expect(result!.bytes.equals(plain)).toBe(true);
    expect(urls.some((u) => u.includes('thumb-param'))).toBe(true);
  });
});
