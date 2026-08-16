import type { ContextTokenRepository } from './context-token.repository.js';
import type { WeixinMediaService, DownloadedMedia } from './media.service.js';
import type { WeixinSendService } from './send.service.js';
import type {
  InboundFile,
  WeixinInboundHandler,
  WeixinInboundMessageContext,
  WeixinReply,
} from './types.js';
import type { WeixinVoiceReplyService } from './voice-reply.service.js';

const ITEM_TYPE_TEXT = 1;
const ITEM_TYPE_IMAGE = 2;
const ITEM_TYPE_FILE = 4;

export class InboundProcessor {
  constructor(
    private readonly inboundHandler: WeixinInboundHandler,
    private readonly contextTokenRepository: ContextTokenRepository,
    private readonly weixinSendService: WeixinSendService,
    private readonly weixinMediaService: WeixinMediaService,
    private readonly weixinVoiceReplyService: WeixinVoiceReplyService,
  ) {}

  async processInboundMessage(accountId: string, message: Record<string, unknown>): Promise<void> {
    try {
      const fromUserId = String(message.from_user_id ?? '');
      const contextToken = message.context_token != null ? String(message.context_token) : null;
      if (contextToken != null && contextToken !== '') {
        await this.contextTokenRepository.saveOrUpdate(accountId, fromUserId, contextToken);
      }
      const body = this.extractMessageBody(message);
      const images = await this.downloadImages(message);
      const fileResult = await this.downloadFiles(message);
      const files = fileResult.files;
      if ((body == null || body.trim() === '') && images.length === 0
        && files.length === 0 && fileResult.failedNames.length === 0) {
        console.info(`忽略空消息（无文本无图片无文件）, accountId=${accountId}, fromUserId=${fromUserId}`);
        return;
      }
      const imageDataUris: string[] = [];
      let mediaPath: string | null = null;
      let mediaType: string | null = null;
      for (const media of images) {
        imageDataUris.push(media.dataUri);
        if (mediaPath == null) {
          mediaPath = media.path;
          mediaType = media.mimeType;
        }
      }
      const context: WeixinInboundMessageContext = {
        accountId,
        fromUserId,
        body: body ?? '',
        contextToken,
        mediaPath,
        mediaType,
        imageDataUris,
        files,
        fileDownloadErrors: fileResult.failedNames,
        rawMessage: message,
      };
      try {
        const reply = await this.inboundHandler.onMessage(context);
        if (reply == null) {
          console.debug(`微信消息处理已取消（被后续消息接管）, accountId=${accountId}, fromUserId=${fromUserId}`);
          return;
        }
        if (reply.text != null && reply.text !== '') {
          await this.sendReply(accountId, fromUserId, contextToken, reply);
        }
      } catch (error) {
        console.error(`处理微信消息失败, accountId=${accountId}, fromUserId=${fromUserId}`, error);
      }
    } catch (e) {
      console.error('处理入站消息失败', e);
    }
  }

  private extractMessageBody(message: Record<string, unknown>): string {
    try {
      const itemList = message.item_list as unknown[] | undefined;
      if (!Array.isArray(itemList) || itemList.length === 0) return '';
      for (const item of itemList) {
        const rec = item as Record<string, unknown>;
        const type = Number(rec.type ?? -1);
        if (type === ITEM_TYPE_TEXT) {
          const textItem = rec.text_item as Record<string, unknown> | undefined;
          if (textItem != null && textItem.text != null) return String(textItem.text);
        }
      }
      for (const item of itemList) {
        const rec = item as Record<string, unknown>;
        const type = Number(rec.type ?? -1);
        if (type === 3) {
          const voiceItem = rec.voice_item as Record<string, unknown> | undefined;
          if (voiceItem != null && voiceItem.text != null) {
            const text = String(voiceItem.text);
            if (text.trim() !== '') return text;
          }
        }
      }
      if (message.description != null) return String(message.description);
      return '';
    } catch (e) {
      console.warn('提取消息正文失败', e);
      return '';
    }
  }

  private async downloadImages(message: Record<string, unknown>): Promise<DownloadedMedia[]> {
    const result: DownloadedMedia[] = [];
    const itemList = message.item_list as unknown[] | undefined;
    if (!Array.isArray(itemList)) return result;
    for (const item of itemList) {
      const rec = item as Record<string, unknown>;
      if (Number(rec.type ?? -1) !== ITEM_TYPE_IMAGE) continue;
      const downloaded = await this.weixinMediaService.downloadImage(rec.image_item as Record<string, unknown>);
      if (downloaded != null) result.push(downloaded);
      else console.warn('微信图片下载失败，跳过该图片项');
    }
    return result;
  }

  private async downloadFiles(message: Record<string, unknown>): Promise<{ files: InboundFile[]; failedNames: string[] }> {
    const files: InboundFile[] = [];
    const failedNames: string[] = [];
    const itemList = message.item_list as unknown[] | undefined;
    if (!Array.isArray(itemList)) return { files, failedNames };
    for (const item of itemList) {
      const rec = item as Record<string, unknown>;
      if (Number(rec.type ?? -1) !== ITEM_TYPE_FILE) continue;
      const fileItem = rec.file_item as Record<string, unknown> | undefined;
      const fileName = this.extractFileDisplayName(fileItem);
      const downloaded = await this.weixinMediaService.downloadFile(fileItem ?? null);
      if (downloaded != null) {
        files.push({ fileName: downloaded.fileName, bytes: downloaded.bytes, mimeType: downloaded.mimeType });
      } else {
        console.warn(`微信文件下载失败，记录失败项, fileName=${fileName}`);
        failedNames.push(fileName);
      }
    }
    return { files, failedNames };
  }

  private extractFileDisplayName(fileItem: Record<string, unknown> | null | undefined): string {
    if (fileItem != null) {
      const name = fileItem.file_name;
      if (name != null && String(name).trim() !== '') return String(name);
    }
    return '未知文件';
  }

  private async sendReply(accountId: string, toUserId: string, contextToken: string | null, reply: WeixinReply): Promise<void> {
    try {
      if (contextToken == null || contextToken === '') {
        console.warn(`无法发送回复: 缺少context_token, accountId=${accountId}, toUserId=${toUserId}`);
        return;
      }
      const success = await this.weixinSendService.sendText(accountId, toUserId, reply.text!);
      if (success) console.debug(`发送微信回复成功, accountId=${accountId}, toUserId=${toUserId}`);
      else console.warn(`发送微信回复失败, accountId=${accountId}, toUserId=${toUserId}`);
      const text = reply.text;
      if (success && text != null && text !== '') {
        void this.weixinVoiceReplyService.sendVoiceReply(accountId, toUserId, text).then((voiceSent) => {
          if (!voiceSent) {
            console.debug(`微信语音回复未发送（开关关闭或链路失败）, accountId=${accountId}, toUserId=${toUserId}`);
          }
        });
      }
    } catch (e) {
      console.error('发送回复消息失败', e);
    }
  }
}
