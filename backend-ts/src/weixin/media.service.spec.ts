import { describe, expect, it, vi } from 'vitest';
import {
  decodeAesKey,
  decryptWeixinAes128Ecb,
  detectFileMime,
  resolveAesKey,
  resolveEncryptQueryParam,
  resolveMediaNode,
} from './media-crypto.js';
import { encryptAes128Ecb } from '../crypto/aes-gcm.js';
import { WeixinMediaService } from './media.service.js';
import { DEFAULT_WEIXIN_BOT_CONFIG } from './types.js';
import type { WeixinHttpClient, WeixinHttpResponse } from './weixin-http.js';

describe('WeixinMediaService', () => {
  it('decodeAesKey_raw16BytesBase64', () => {
    const key = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) key[i] = i;
    const encoded = key.toString('base64');
    expect(decodeAesKey(encoded)?.equals(key)).toBe(true);
  });

  it('decodeAesKey_base64OfHexAscii', () => {
    const hex = '00112233445566778899aabbccddeeff';
    const encoded = Buffer.from(hex, 'ascii').toString('base64');
    const decoded = decodeAesKey(encoded)!;
    expect(decoded.length).toBe(16);
    expect(decoded[0]).toBe(0x00);
    expect(decoded[15]).toBe(0xff);
  });

  it('decodeAesKey_directHex', () => {
    const decoded = decodeAesKey('00112233445566778899aabbccddeeff')!;
    expect(decoded.length).toBe(16);
    expect(decoded[10]).toBe(0xaa);
  });

  it('resolveAesKey_prefersImageItemAeskey', () => {
    const imageItem = { aeskey: '00112233445566778899aabbccddeeff' };
    const media = { aes_key: Buffer.alloc(16).toString('base64') };
    const key = resolveAesKey(imageItem, media)!;
    expect(key[1]).toBe(0x11);
  });

  it('decryptAes128Ecb_roundTrip', () => {
    const key = Buffer.from('0123456789abcdef', 'ascii');
    const plain = Buffer.from('hello-weixin-img!', 'utf8');
    const ciphertext = encryptAes128Ecb(plain, key);
    expect(decryptWeixinAes128Ecb(ciphertext, key).equals(plain)).toBe(true);
  });

  it('detectFileMime_pdfByMagicNumber', () => {
    expect(detectFileMime(Buffer.from('%PDF-1.7', 'ascii'), 'unknown.bin')).toBe('application/pdf');
  });

  it('detectFileMime_pdfByExtension', () => {
    expect(detectFileMime(Buffer.alloc(0), 'report.PDF')).toBe('application/pdf');
  });

  it('detectFileMime_docxByExtension', () => {
    expect(detectFileMime(Buffer.alloc(0), 'doc.docx'))
      .toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it('detectFileMime_unknownFallsBackToOctetStream', () => {
    expect(detectFileMime(Buffer.alloc(0), 'archive.xyz')).toBe('application/octet-stream');
  });

  it('resolveEncryptQueryParam_mediaLevel', () => {
    expect(resolveEncryptQueryParam({ media: { encrypt_query_param: 'media-param' } })).toBe('media-param');
  });

  it('resolveEncryptQueryParam_fallsBackToItemLevel', () => {
    expect(resolveEncryptQueryParam({ media: {}, encrypt_query_param: 'item-param' })).toBe('item-param');
  });

  it('resolveEncryptQueryParam_fallsBackToThumbMedia', () => {
    expect(resolveEncryptQueryParam({ thumb_media: { encrypt_query_param: 'thumb-param' } })).toBe('thumb-param');
  });

  it('resolveEncryptQueryParam_missingReturnsNull', () => {
    expect(resolveEncryptQueryParam({ media: {} })).toBeNull();
  });

  it('resolveMediaNode_prefersMediaWithParam', () => {
    const node = resolveMediaNode({
      media: { encrypt_query_param: 'media-param' },
      thumb_media: { encrypt_query_param: 'thumb-param' },
    })!;
    expect(node.encrypt_query_param).toBe('media-param');
  });

  it('resolveMediaNode_fallsBackToThumbMediaWhenMediaIncomplete', () => {
    const validKey = Buffer.alloc(16).toString('base64');
    const fileItem = {
      media: { file_name: 'x.pdf' },
      thumb_media: { encrypt_query_param: 'thumb-param', aes_key: validKey },
    };
    const node = resolveMediaNode(fileItem)!;
    expect(node.encrypt_query_param).toBe('thumb-param');
    const key = resolveAesKey(fileItem, node);
    expect(key).not.toBeNull();
  });

  it('resolveAesKey_fallsBackToItemLevelAesKey', () => {
    const key = resolveAesKey({ aes_key: Buffer.alloc(16).toString('base64') }, {});
    expect(key?.length).toBe(16);
  });

  it('resolveAesKey_prefersItemAeskeyOverItemAesKey', () => {
    const key = resolveAesKey({
      aeskey: '00112233445566778899aabbccddeeff',
      aes_key: Buffer.alloc(16).toString('base64'),
    }, null)!;
    expect(key[1]).toBe(0x11);
  });
});

function jpegBytes(): Buffer {
  return Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b]);
}

function okClient(body: Buffer, status = 200): WeixinHttpClient {
  return {
    request: vi.fn(async () => ({
      status,
      headers: {},
      body,
      header: () => undefined,
    } as WeixinHttpResponse)),
  };
}

describe('WeixinMediaService download', () => {
  const key = Buffer.from('0123456789abcdef', 'ascii');
  const aeskey = key.toString('base64');

  it('returns null for missing media or encrypt param', async () => {
    const svc = new WeixinMediaService(DEFAULT_WEIXIN_BOT_CONFIG, { image: okClient(Buffer.alloc(0)), file: okClient(Buffer.alloc(0)) });
    expect(await svc.downloadImage(null)).toBeNull();
    expect(await svc.downloadImage({})).toBeNull();
    expect(await svc.downloadImage({ media: {} })).toBeNull();
    expect(await svc.downloadFile(null)).toBeNull();
    expect(await svc.downloadFile({ media: {} })).toBeNull();
  });

  it('downloads decrypts and writes image', async () => {
    const cipher = encryptAes128Ecb(jpegBytes(), key);
    const image = okClient(cipher);
    const svc = new WeixinMediaService({ ...DEFAULT_WEIXIN_BOT_CONFIG, cdnBaseUrl: 'https://cdn.example/c2c/' }, { image, file: image });
    const result = await svc.downloadImage({
      media: { encrypt_query_param: 'q1', aes_key: aeskey },
    });
    expect(result).not.toBeNull();
    expect(result!.mimeType).toContain('image');
    expect(result!.dataUri.startsWith('data:')).toBe(true);
    expect(result!.path).toContain('weixin-media');
  });

  it('treats missing aes key as plaintext and rejects empty body', async () => {
    const image = okClient(jpegBytes());
    const svc = new WeixinMediaService(DEFAULT_WEIXIN_BOT_CONFIG, { image, file: image });
    const result = await svc.downloadImage({ media: { encrypt_query_param: 'plain' } });
    expect(result).not.toBeNull();
    const empty = okClient(Buffer.alloc(0));
    const emptySvc = new WeixinMediaService(DEFAULT_WEIXIN_BOT_CONFIG, { image: empty, file: empty });
    expect(await emptySvc.downloadImage({ media: { encrypt_query_param: 'q' } })).toBeNull();
  });

  it('returns null on http error and thrown request', async () => {
    const fail = okClient(Buffer.from('x'), 500);
    const svc = new WeixinMediaService(DEFAULT_WEIXIN_BOT_CONFIG, { image: fail, file: fail });
    expect(await svc.downloadImage({ media: { encrypt_query_param: 'q', aes_key: aeskey } })).toBeNull();
    const boom: WeixinHttpClient = { request: vi.fn(async () => { throw new Error('net'); }) };
    const boomSvc = new WeixinMediaService(DEFAULT_WEIXIN_BOT_CONFIG, { image: boom, file: boom });
    expect(await boomSvc.downloadImage({ media: { encrypt_query_param: 'q', aes_key: aeskey } })).toBeNull();
    expect(await boomSvc.downloadFile({ media: { encrypt_query_param: 'q', file_name: 'a.pdf', aes_key: aeskey } })).toBeNull();
  });

  it('downloads file with name from media node', async () => {
    const pdf = Buffer.from('%PDF-1.4 hello', 'ascii');
    const cipher = encryptAes128Ecb(pdf, key);
    const file = okClient(cipher);
    const svc = new WeixinMediaService(DEFAULT_WEIXIN_BOT_CONFIG, { image: file, file });
    const result = await svc.downloadFile({
      media: { encrypt_query_param: 'fq', aes_key: aeskey, file_name: 'report.pdf' },
    });
    expect(result?.fileName).toBe('report.pdf');
    expect(result?.mimeType).toBe('application/pdf');
  });

  it('generates fallback file name when missing', async () => {
    const file = okClient(Buffer.from('hello world!!'));
    const svc = new WeixinMediaService({ ...DEFAULT_WEIXIN_BOT_CONFIG, cdnBaseUrl: '' }, { image: file, file });
    const result = await svc.downloadFile({ encrypt_query_param: 'fq' });
    expect(result?.fileName).toMatch(/^file-.+\.bin$/);
  });
});

