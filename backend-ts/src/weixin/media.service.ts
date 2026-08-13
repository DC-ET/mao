import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ImageFileSupport } from '../harness/tool/image-file-support.js';
import { PromptImageResizer } from '../harness/tool/prompt-image-resizer.js';
import type { WeixinBotConfig } from './types.js';
import { DEFAULT_CDN_BASE } from './types.js';
import { createWeixinHttpClient, type WeixinHttpClient } from './weixin-http.js';
import {
  decodeAesKey,
  decryptWeixinAes128Ecb,
  detectFileMime,
  extensionForMime,
  resolveAesKey,
  resolveEncryptQueryParam,
  resolveMediaNode,
  textOrNull,
} from './media-crypto.js';

export {
  decodeAesKey,
  decryptWeixinAes128Ecb,
  detectFileMime,
  resolveAesKey,
  resolveEncryptQueryParam,
  resolveMediaNode,
};

export interface DownloadedMedia {
  path: string;
  mimeType: string;
  dataUri: string;
}

export interface DownloadedFile {
  fileName: string;
  bytes: Buffer;
  mimeType: string;
}

export class WeixinMediaService {
  private readonly httpClient: WeixinHttpClient;
  private readonly fileHttpClient: WeixinHttpClient;

  constructor(
    private readonly weixinBotConfig: WeixinBotConfig,
    http?: { image?: WeixinHttpClient; file?: WeixinHttpClient },
  ) {
    this.httpClient = http?.image ?? createWeixinHttpClient(60_000);
    this.fileHttpClient = http?.file ?? createWeixinHttpClient(180_000);
  }

  async downloadImage(imageItem: Record<string, unknown> | null | undefined): Promise<DownloadedMedia | null> {
    if (imageItem == null) return null;
    let media = imageItem.media as Record<string, unknown> | undefined;
    if (media == null) media = imageItem.thumb_media as Record<string, unknown> | undefined;
    if (media == null) {
      console.warn('图片消息缺少 media/thumb_media');
      return null;
    }
    const encryptQueryParam = textOrNull(media.encrypt_query_param);
    if (encryptQueryParam == null || encryptQueryParam.trim() === '') {
      console.warn('图片消息缺少 encrypt_query_param');
      return null;
    }
    const aesKey = resolveAesKey(imageItem, media);
    try {
      const ciphertext = await this.downloadCiphertext(encryptQueryParam, this.httpClient);
      if (ciphertext == null || ciphertext.length === 0) return null;
      let plaintext = aesKey != null ? decryptWeixinAes128Ecb(ciphertext, aesKey) : ciphertext;
      if (aesKey == null) console.warn('图片消息缺少 AES key，尝试按明文处理');
      if (plaintext.length > ImageFileSupport.MAX_IMAGE_BYTES) {
        console.warn(`图片过大: ${ImageFileSupport.formatSize(plaintext.length)} > ${ImageFileSupport.formatSize(ImageFileSupport.MAX_IMAGE_BYTES)}`);
        return null;
      }
      const mime = ImageFileSupport.detectMimeFromBytes(plaintext) ?? 'image/jpeg';
      const resized = await PromptImageResizer.tryResizeForPrompt(plaintext, mime);
      const outBytes = resized != null ? resized.bytes : plaintext;
      const outMime = resized != null ? resized.mime : mime;
      const ext = extensionForMime(outMime);
      const dir = join(tmpdir(), 'weixin-media');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${randomUUID()}${ext}`);
      writeFileSync(path, outBytes);
      const dataUri = `data:${outMime};base64,${outBytes.toString('base64')}`;
      return { path, mimeType: outMime, dataUri };
    } catch (e) {
      console.error('下载或解密微信图片失败', e);
      return null;
    }
  }

  async downloadFile(fileItem: Record<string, unknown> | null | undefined): Promise<DownloadedFile | null> {
    if (fileItem == null) return null;
    const encryptQueryParam = resolveEncryptQueryParam(fileItem);
    if (encryptQueryParam == null || encryptQueryParam.trim() === '') {
      console.warn('文件消息缺少 encrypt_query_param');
      return null;
    }
    const media = resolveMediaNode(fileItem);
    const aesKey = resolveAesKey(fileItem, media);
    try {
      const ciphertext = await this.downloadCiphertext(encryptQueryParam, this.fileHttpClient);
      if (ciphertext == null || ciphertext.length === 0) return null;
      const plaintext = aesKey != null ? decryptWeixinAes128Ecb(ciphertext, aesKey) : ciphertext;
      if (aesKey == null) console.warn('文件消息缺少 AES key，尝试按明文处理');
      const fileName = this.extractFileName(fileItem);
      const mime = detectFileMime(plaintext, fileName);
      return { fileName, bytes: plaintext, mimeType: mime };
    } catch (e) {
      console.error('下载或解密微信文件失败', e);
      return null;
    }
  }

  async downloadCiphertext(encryptQueryParam: string, client: WeixinHttpClient = this.httpClient): Promise<Buffer | null> {
    let cdnBase = this.weixinBotConfig.cdnBaseUrl;
    if (cdnBase == null || cdnBase.trim() === '') cdnBase = DEFAULT_CDN_BASE;
    if (cdnBase.endsWith('/')) cdnBase = cdnBase.slice(0, -1);
    const fullUrl = `${cdnBase}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;
    const response = await client.request(fullUrl, { method: 'GET' });
    if (response.status < 200 || response.status >= 300) {
      console.error(`CDN 下载失败: HTTP ${response.status}`);
      return null;
    }
    return response.body;
  }

  private extractFileName(fileItem: Record<string, unknown>): string {
    let name = textOrNull(fileItem.file_name);
    if (name == null || name.trim() === '') {
      const media = fileItem.media as Record<string, unknown> | undefined;
      const mediaName = media != null ? textOrNull(media.file_name) : null;
      if (mediaName != null && mediaName.trim() !== '') name = mediaName;
    }
    if (name == null || name.trim() === '') {
      return `file-${randomUUID()}.bin`;
    }
    return name;
  }
}
