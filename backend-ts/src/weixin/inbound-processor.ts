import type { ContextTokenRepository } from './context-token.repository.js';
import { randomUUID } from 'node:crypto';
import type { WeixinMediaService, DownloadedMedia } from './media.service.js';
import { extensionForMime } from './media-crypto.js';
import type { WeixinSendService } from './send.service.js';
import { WeixinInboundMessageRepository } from './inbound-message.repository.js';
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
    private readonly inboundMessages?: WeixinInboundMessageRepository,
  ) {}

  /**
   * 入队一条拉取到的消息（在 monitor 循环中 await 调用）。
   * 返回 null 表示消息已在认领表中（服务端重投，跳过）；否则返回指纹供后续处理与游标判定。
   * 同指纹 DONE 超过去重窗口（24h）视为用户合法重发，重置行状态后照常处理。
   */
  async enqueueInboundMessage(accountId: string, message: Record<string, unknown>): Promise<string | null> {
    const repo = this.inboundMessages;
    if (repo == null) return null;
    const messageKey = WeixinInboundMessageRepository.messageKeyOf(message);
    const enqueued = await repo.enqueue(accountId, messageKey, JSON.stringify(message));
    if (!enqueued) {
      if (await repo.shouldSkipDuplicate(accountId, messageKey)) {
        console.info(`微信消息重复（疑似服务端重投），跳过, accountId=${accountId}, key=${messageKey.slice(0, 12)}`);
        return null;
      }
      // 用户合法重发相同内容：回收既有行重新进入处理
      await repo.reclaimForResend(accountId, messageKey, JSON.stringify(message));
    }
    return messageKey;
  }

  /**
   * 处理一条已入队的消息（CLAIMED → DONE/FAILED）。
   * 处理期间定期心跳刷新 updated_at：重放器只回收「无心跳超 10 分钟」的中断消息，
   * 正常长执行不会被误判中断而并发双执行。
   */
  async processInboundMessage(accountId: string, message: Record<string, unknown>, knownKey?: string | null): Promise<void> {
    const repo = this.inboundMessages;
    const messageKey = repo ? (knownKey ?? WeixinInboundMessageRepository.messageKeyOf(message)) : null;
    // 未挂认领表的直接调用（或既有调用方未先入队）：自行入队，重复则跳过。
    if (repo != null && knownKey == null) {
      const enqueued = await repo.enqueue(accountId, messageKey!, JSON.stringify(message));
      if (!enqueued) {
        if (await repo.shouldSkipDuplicate(accountId, messageKey!)) {
          console.debug(`微信消息重复，跳过, accountId=${accountId}, key=${messageKey!.slice(0, 12)}`);
          return;
        }
        await repo.reclaimForResend(accountId, messageKey!, JSON.stringify(message));
      }
    }
    const stopHeartbeat = this.startHeartbeat(repo ?? null, accountId, messageKey);
    try {
      await this.processClaimed(accountId, message);
      if (repo != null && messageKey != null) await repo.markDone(accountId, messageKey);
    } catch (e) {
      console.error(`处理微信入站消息失败, accountId=${accountId}`, e);
      if (repo != null && messageKey != null) await repo.markFailed(accountId, messageKey);
    } finally {
      stopHeartbeat();
    }
  }

  /** 处理已在认领表中登记的消息（重放路径：行已存在，无需再次入队）。 */
  async processReplayedMessage(accountId: string, messageKey: string, message: Record<string, unknown>): Promise<void> {
    const stopHeartbeat = this.startHeartbeat(this.inboundMessages ?? null, accountId, messageKey);
    try {
      await this.processClaimed(accountId, message);
      await this.inboundMessages!.markDone(accountId, messageKey);
    } catch (e) {
      console.error(`重放微信入站消息失败, accountId=${accountId}`, e);
      await this.inboundMessages!.markFailed(accountId, messageKey);
    } finally {
      stopHeartbeat();
    }
  }

  /** CLAIMED 处理期心跳：进程崩溃后心跳停止，超时被重放器回收；正常执行持续存活。 */
  private startHeartbeat(
    repo: WeixinInboundMessageRepository | null,
    accountId: string,
    messageKey: string | null,
  ): () => void {
    if (repo == null || messageKey == null) return () => {};
    const beat = () => {
      void repo.heartbeat(accountId, messageKey).catch((e) =>
        console.warn(`微信入站心跳刷新失败, accountId=${accountId}`, e));
    };
    beat(); // 启动即心跳一次：避免回收/入队后至首个周期间的窗口被再次回收
    const timer = setInterval(beat, WeixinInboundMessageRepository.HEARTBEAT_INTERVAL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** 是否有在途（CLAIMED 且未超时）消息；未挂认领表时恒为 false。 */
  async hasInFlightMessages(accountId: string): Promise<boolean> {
    return this.inboundMessages?.hasInFlight(accountId) ?? false;
  }

  /**
   * 取回待重放消息并返回可执行项；未挂认领表时恒为空。
   * 每项 run() 驱动 DONE/FAILED 状态机（processReplayedMessage）。
   */
  async reclaimStuckMessages(accountId: string): Promise<Array<{ messageKey: string; run: () => Promise<void> }>> {
    const repo = this.inboundMessages;
    if (repo == null) return [];
    const rows = await repo.reclaimStuck(accountId);
    const out: Array<{ messageKey: string; run: () => Promise<void> }> = [];
    for (const row of rows) {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(row.payload) as Record<string, unknown>;
      } catch (e) {
        console.error(`微信入站重放消息 payload 损坏，标记 FAILED, accountId=${accountId}, key=${row.messageKey.slice(0, 12)}`, e);
        await repo.markFailed(accountId, row.messageKey);
        continue;
      }
      out.push({
        messageKey: row.messageKey,
        run: () => this.processReplayedMessage(accountId, row.messageKey, message),
      });
    }
    return out;
  }

  private async processClaimed(accountId: string, message: Record<string, unknown>): Promise<void> {
    const fromUserId = String(message.from_user_id ?? '');
    const contextToken = message.context_token != null ? String(message.context_token) : null;
    if (contextToken != null && contextToken !== '') {
      await this.contextTokenRepository.saveOrUpdate(accountId, fromUserId, contextToken);
    }
    const body = this.extractMessageBody(message);
    const imageResult = await this.downloadImages(message);
    const fileResult = await this.downloadFiles(message);
    const files = [...imageResult.files, ...fileResult.files];
    if ((body == null || body.trim() === '') && imageResult.files.length === 0
      && fileResult.files.length === 0 && fileResult.failedNames.length === 0) {
      console.info(`忽略空消息（无文本无图片无文件）, accountId=${accountId}, fromUserId=${fromUserId}`);
      return;
    }
    const imageDataUris: string[] = [];
    let mediaPath: string | null = null;
    let mediaType: string | null = null;
    for (const media of imageResult.media) {
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
      imageFileNames: imageResult.fileNames,
      files,
      fileDownloadErrors: fileResult.failedNames,
      rawMessage: message,
    };
    const reply = await this.inboundHandler.onMessage(context);
    if (reply == null) {
      console.debug(`微信消息处理已取消（被后续消息接管）, accountId=${accountId}, fromUserId=${fromUserId}`);
      return;
    }
    if (reply.text != null && reply.text !== '') {
      await this.sendReply(accountId, fromUserId, contextToken, reply);
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

  private async downloadImages(message: Record<string, unknown>): Promise<{ media: DownloadedMedia[]; files: InboundFile[]; fileNames: string[] }> {
    const media: DownloadedMedia[] = [];
    const files: InboundFile[] = [];
    const fileNames: string[] = [];
    const itemList = message.item_list as unknown[] | undefined;
    if (!Array.isArray(itemList)) return { media, files, fileNames };
    for (const item of itemList) {
      const rec = item as Record<string, unknown>;
      if (Number(rec.type ?? -1) !== ITEM_TYPE_IMAGE) continue;
      const downloaded = await this.weixinMediaService.downloadImage(rec.image_item as Record<string, unknown>);
      if (downloaded != null) {
        media.push(downloaded);
        const fileName = this.buildImageFileName(downloaded.mimeType);
        files.push({
          fileName,
          bytes: downloaded.bytes,
          mimeType: downloaded.mimeType,
        });
        fileNames.push(fileName);
      } else {
        console.warn('微信图片下载失败，跳过该图片项');
      }
    }
    return { media, files, fileNames };
  }

  private buildImageFileName(mimeType: string): string {
    const ext = extensionForMime(mimeType);
    return `image-${randomUUID()}${ext}`;
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
        await this.sendFallbackNotice(accountId, toUserId);
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
        return;
      }
      // 发送失败时不能静默：用户侧没有任何提示会以为 Agent 卡死。
      // 原始回复已入库，桌面端/网页端可见，这里只发一条短降级说明指路。
      await this.sendFallbackNotice(accountId, toUserId);
    } catch (e) {
      console.error('发送回复消息失败', e);
    }
  }

  /** 下行失败时给用户一条可感知的短说明，避免「Agent 跑完了但微信上什么都没收到」。 */
  private async sendFallbackNotice(accountId: string, toUserId: string): Promise<void> {
    try {
      const sent = await this.weixinSendService.sendText(
        accountId,
        toUserId,
        '回复发送失败了，但回答已经生成。请在电脑端打开 Mao 查看完整内容。',
      );
      if (!sent) {
        console.warn(`微信下行降级提示也发送失败, accountId=${accountId}, toUserId=${toUserId}`);
      }
    } catch (e) {
      console.error('发送微信下行降级提示失败', e);
    }
  }
}
