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
import type { WeixinWebhookFallbackService } from './webhook-fallback.service.js';
import { InboundMergeWindow } from '../common/inbound-merge-window.js';

const ITEM_TYPE_TEXT = 1;
const ITEM_TYPE_IMAGE = 2;
const ITEM_TYPE_FILE = 4;

/**
 * 窗口条目：入队（认领表 CLAIMED）后的待处理消息。
 * messageKey 是认领表幂等键：合并执行期间所有 absorbed key 都要持续心跳，
 * 否则会被重放器按「无心跳超 10 分钟」回收，与合并执行并发双跑。
 */
interface WeixinWindowEntry {
  accountId: string;
  message: Record<string, unknown>;
  /** 认领表键；未挂认领表（直接调用）时为空串。 */
  messageKey: string;
  /** process() 入口同步分配的到达序号：保证合并顺序 = 到达顺序。 */
  arrivalSeq: number;
}

export class InboundProcessor {
  /** process() 入口同步分配的到达序号（跨账号单调即可，窗口内只比较同键条目）。 */
  private arrivalSeqCounter = 0;

  /** 入站防抖合并窗口：同账号 + 发送者的连续纯文本消息合并为一次触发；0 = 禁用（与加窗前一致）。 */
  private readonly window: InboundMergeWindow<WeixinWindowEntry>;

  constructor(
    private readonly inboundHandler: WeixinInboundHandler,
    private readonly contextTokenRepository: ContextTokenRepository,
    private readonly weixinSendService: WeixinSendService,
    private readonly weixinMediaService: WeixinMediaService,
    private readonly weixinVoiceReplyService: WeixinVoiceReplyService,
    private readonly inboundMessages?: WeixinInboundMessageRepository,
    /** webhook 降级推送（可选）：微信下行失败时把回复送到用户配置的钉钉/飞书。 */
    private readonly webhookFallback?: WeixinWebhookFallbackService,
    /** 账号仓库（可选）：降级推送前用 accountId 反查归属 userId。 */
    private readonly accountRepository?: { findByAccountId(accountId: string): Promise<{ userId?: number | null } | null> },
    /** 入站防抖合并窗口时长（ms）。同账号 + 发送者的连续纯文本消息合并为一次触发；0 = 禁用。 */
    private readonly mergeWindowMs = 0,
  ) {
    this.window = new InboundMergeWindow<WeixinWindowEntry>({
      windowMs: mergeWindowMs,
      keyOf: (entry) => this.windowKeyOf(entry),
      dedupeKeyOf: (entry) => (entry.messageKey === '' ? null : entry.messageKey),
      canJoin: (entry) => this.canJoinEntry(entry),
      seqOf: (entry) => entry.arrivalSeq,
      onFlush: (batch) => this.flushEntries(batch),
    });
  }

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
   * 入队（幂等键 + payload 落库）在本方法内同步完成，随后提交到合并窗口：
   * 窗口期内同发送者的连续纯文本消息会合并为一次 handler.onMessage；
   * mergeWindowMs=0 时立即单条处理，行为与加窗前一致。
   * 返回只代表「已提交」：窗口期内的消息实际处理发生在 flush 时（由窗口驱动）。
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
    // 到达序号必须在任何 await 之前同步分配：入队耗时差异会让 submit 顺序偏离到达顺序，
    // 批内排序以此恢复「合并顺序 = 到达顺序」。
    const arrivalSeq = (this.arrivalSeqCounter += 1);
    await this.window.submit({
      accountId, message, messageKey: messageKey ?? '', arrivalSeq,
    });
  }

  /**
   * 窗口 flush 入口：批内消息合并为一条合成消息走既有处理链，
   * 执行期间对所有 absorbed key 持续心跳，结束后按成败整批 markDone/markFailed。
   * 失败走重放器（每条原消息各自重放），避免合并执行失败导致内容丢失。
   */
  private async flushEntries(batch: WeixinWindowEntry[]): Promise<void> {
    const repo = this.inboundMessages;
    const accountId = batch[0].accountId;
    const keys = batch.map((entry) => entry.messageKey).filter((key) => key !== '');
    const merged = this.mergeMessages(batch);
    const stopHeartbeat = this.startHeartbeat(repo ?? null, accountId, keys);
    try {
      await this.processClaimed(accountId, merged);
      if (repo != null) {
        for (const key of keys) await repo.markDone(accountId, key);
      }
    } catch (e) {
      console.error(`处理微信入站消息失败, accountId=${accountId}, merged=${batch.length}条`, e);
      if (repo != null) {
        // 整批标记失败交重放器：重放时每条原消息单独处理，内容不丢。
        for (const key of keys) await repo.markFailed(accountId, key);
      }
    } finally {
      stopHeartbeat();
    }
  }

  /**
   * 合成合并消息：单条（豁免/禁用路径）原样返回，与加窗前的处理链完全一致。
   * 多条时（canJoin 已保证批内全是纯文本）：发送方取首条，context_token 取最后非空
   * （回复只能用最新 token），正文按到达序拼接为单个文本项——extractMessageBody
   * 只取第一个文本项，不合并就会丢失后续消息的正文。
   * description 删除：正文已并入 item_list，避免空正文时兜底读到首条描述。
   */
  private mergeMessages(entries: WeixinWindowEntry[]): Record<string, unknown> {
    if (entries.length === 1) return entries[0].message;
    const first = entries[0].message;
    const bodies = entries
      .map((entry) => this.extractMessageBody(entry.message))
      .filter((body) => body.trim() !== '');
    let contextToken: unknown = first.context_token ?? null;
    for (const entry of entries) {
      const token = entry.message.context_token;
      if (token != null && String(token) !== '') contextToken = token;
    }
    const merged: Record<string, unknown> = {
      ...first,
      context_token: contextToken,
      item_list: [{ type: ITEM_TYPE_TEXT, text_item: { text: bodies.join('\n') } }],
    };
    delete merged.description;
    return merged;
  }

  /** 窗口键 = 账号 + 发送者：只合同一用户在同一账号下的连续消息。 */
  private windowKeyOf(entry: WeixinWindowEntry): string {
    return `${entry.accountId}:${String(entry.message.from_user_id ?? '')}`;
  }

  /** 准入：仅纯文本消息入窗。带图片/文件/语音的消息整体豁免出窗（媒体不跨消息合并）。 */
  private canJoinEntry(entry: WeixinWindowEntry): boolean {
    const itemList = entry.message.item_list;
    if (!Array.isArray(itemList)) return true;
    return itemList.every((item) => Number((item as Record<string, unknown>).type ?? -1) === ITEM_TYPE_TEXT);
  }

  /** 处理已在认领表中登记的消息（重放路径：行已存在，无需再次入队）。
   *  重放不经过合并窗口：行已是独立 CLAIMED 记录，与在窗新消息合并会双跑。 */
  async processReplayedMessage(accountId: string, messageKey: string, message: Record<string, unknown>): Promise<void> {
    const stopHeartbeat = this.startHeartbeat(this.inboundMessages ?? null, accountId, [messageKey]);
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

  /** CLAIMED 处理期心跳：进程崩溃后心跳停止，超时被重放器回收；正常执行持续存活。
   *  合并执行期间对批内所有 absorbed key 心跳——漏掉任何一个都会被重放器回收并发重跑。 */
  private startHeartbeat(
    repo: WeixinInboundMessageRepository | null,
    accountId: string,
    messageKeys: string[],
  ): () => void {
    if (repo == null || messageKeys.length === 0) return () => {};
    const beat = () => {
      for (const messageKey of messageKeys) {
        void repo.heartbeat(accountId, messageKey).catch((e) =>
          console.warn(`微信入站心跳刷新失败, accountId=${accountId}`, e));
      }
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
        // 缺 token 时连降级提示也发不出去，直接走 webhook 兜底。
        const noticeSent = await this.sendFallbackNotice(accountId, toUserId);
        if (!noticeSent) {
          await this.pushWebhookFallback(accountId, reply.text ?? '');
        }
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
      // 依次尝试两条降级路径：先在微信内发短说明指路；微信本身不可达（24h 窗口过期时
      // 连这条也发不出去）时，把回复原文推送到用户配置的钉钉/飞书 webhook。
      const noticeSent = await this.sendFallbackNotice(accountId, toUserId);
      if (!noticeSent) {
        await this.pushWebhookFallback(accountId, text ?? '');
      }
    } catch (e) {
      console.error('发送回复消息失败', e);
    }
  }

  /** 下行失败时给用户一条可感知的短说明，避免「Agent 跑完了但微信上什么都没收到」。返回是否送达。 */
  private async sendFallbackNotice(accountId: string, toUserId: string): Promise<boolean> {
    try {
      const sent = await this.weixinSendService.sendText(
        accountId,
        toUserId,
        '回复发送失败了，但回答已经生成。请在电脑端打开 Mao 查看完整内容。',
      );
      if (!sent) {
        console.warn(`微信下行降级提示也发送失败, accountId=${accountId}, toUserId=${toUserId}`);
      }
      return sent;
    } catch (e) {
      console.error('发送微信下行降级提示失败', e);
      return false;
    }
  }

  /**
   * 微信侧完全不可达时，把回复原文降级推送到用户配置的通知 webhook。
   * 未注入降级器、账号查不到归属用户、用户未配置通知时静默跳过。
   */
  private async pushWebhookFallback(accountId: string, replyText: string): Promise<void> {
    const fallback = this.webhookFallback;
    if (fallback == null) return;
    try {
      const account = await this.accountRepository?.findByAccountId(accountId);
      await fallback.sendFallback(account?.userId, replyText);
    } catch (e) {
      console.warn(`微信回复 webhook 降级推送异常, accountId=${accountId}`, e);
    }
  }
}
