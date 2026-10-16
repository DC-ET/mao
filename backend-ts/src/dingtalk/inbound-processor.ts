import { isInboundFileMessage, isNewSessionCommand, isUnsupportedMedia } from './event-normalizer.js';
import type { DingtalkMessageService } from './message.service.js';
import type { DingtalkInboundContext, DingtalkInboundHandler, DingtalkNormalizedMessage } from './types.js';
import { InboundMergeWindow } from '../common/inbound-merge-window.js';

const IDENTITY_TEXT = '当前无法识别你的钉钉身份';
const OAUTH_MISSING_TEXT = '管理员尚未配置钉钉登录，暂时无法绑定';
const GROUP_UNSUPPORTED_TEXT = '群聊暂不支持该类型，请私聊发送';
const P2P_UNSUPPORTED_TEXT = '暂不支持语音和视频';

export interface DingtalkInboundProcessorOptions {
  messageService?: DingtalkMessageService;
  resolveUserId?: (accountId: string, event: DingtalkNormalizedMessage) => Promise<number | null>;
  sendReply?: (accountId: string, event: DingtalkNormalizedMessage, text: string) => Promise<void>;
  sendBindingCard?: (accountId: string, event: DingtalkNormalizedMessage) => Promise<boolean>;
  oauthConfigured?: () => boolean;
  rememberMember?: (accountId: string, event: DingtalkNormalizedMessage, userId: number) => Promise<void>;
  /** 入站防抖合并窗口时长（ms）。同账号 + 会话 + 发送者的连续文本消息合并为一次触发；0 = 禁用（与加窗前一致）。 */
  mergeWindowMs?: number;
}

/** 可并入窗口的消息类型：纯文本，或不带媒体的富文本（带 downloadCode 的 richText 是图片，不跨消息合并）。 */
const JOINABLE_MSGTYPES = new Set(['text', 'richText']);

/**
 * 窗口条目：到达即完成重活（claim、群日志、身份解析），只把 handler.onMessage
 * 这一个触发点挂到窗口上；flush 时批内合并为一次触发。
 */
interface DingtalkWindowEntry {
  accountId: string;
  event: DingtalkNormalizedMessage;
  /** 已解析的 mao 用户 ID（prepare 时解析，null 分支已在 prepare 内收尾）。 */
  userId: number;
  /** process() 入口同步分配的到达序号：保证合并顺序 = 到达顺序（prepare 耗时不同不会乱序）。 */
  arrivalSeq: number;
}

export class DingtalkInboundProcessor {
  /** process() 入口同步分配的到达序号（跨 bot 单调即可，窗口内只比较同键条目）。 */
  private arrivalSeqCounter = 0;

  /** 入站防抖合并窗口：windowMs=0 时所有消息走豁免路径单条触发，与现状恒等。 */
  private readonly window: InboundMergeWindow<DingtalkWindowEntry>;

  constructor(private readonly handler: DingtalkInboundHandler, private readonly options: DingtalkInboundProcessorOptions = {}) {
    this.window = new InboundMergeWindow<DingtalkWindowEntry>({
      windowMs: options.mergeWindowMs ?? 0,
      keyOf: (entry) => this.windowKeyOf(entry),
      dedupeKeyOf: (entry) => entry.event.messageId,
      canJoin: (entry) => this.canJoinEntry(entry),
      seqOf: (entry) => entry.arrivalSeq,
      onFlush: (batch) => this.flushEntries(batch),
    });
  }

  /** 关机时 best-effort 冲刷在途窗口（只保证触发启动，执行由停机收尾等待/标记）。 */
  async flushAll(): Promise<void> {
    await this.window.flushAll();
  }

  /**
   * 入站主入口：prepare（到达即完成 claim/群日志/身份解析）→ 窗口 submit。
   * `bypassWindow` 供绑定后补投使用：不经过窗口，立即单条触发（与加窗前的补投行为一致）。
   */
  async process(
    accountId: string, event: DingtalkNormalizedMessage, skipClaim = false, options: { bypassWindow?: boolean } = {},
  ): Promise<void> {
    // 到达序号必须在任何 await 之前同步分配：prepare 耗时差异（身份解析是 DB/缓存调用）
    // 会让 submit 顺序偏离到达顺序，批内排序以此恢复「合并顺序 = 到达顺序」。
    const arrivalSeq = (this.arrivalSeqCounter += 1);
    const entry = await this.prepareOne(accountId, event, skipClaim, arrivalSeq);
    if (entry == null) return;
    if (options.bypassWindow) {
      await this.flushEntries([entry]);
      return;
    }
    await this.window.submit(entry);
  }

  /**
   * 到达即执行的重活（与加窗前一致）：claim → 身份/授权 → 群日志落库。
   * 产出窗口条目；不触发的分支（无身份/未@/未绑定/不支持的媒体）在此完成 claim 收尾并返回 null。
   * 触发类条目的 claim 保留到 flush 触发返回后再 complete/release（状态机不变，时机随批次后移）。
   */
  private async prepareOne(
    accountId: string, event: DingtalkNormalizedMessage, skipClaim: boolean, arrivalSeq: number,
  ): Promise<DingtalkWindowEntry | null> {
    const messageService = this.options.messageService;
    const claimed = skipClaim || messageService == null ? true : await messageService.claimInbound(accountId, event);
    if (!claimed) return null;
    let completed = false;
    let entry: DingtalkWindowEntry | null = null;
    try {
      if (event.senderUserid == null || event.senderUserid === '') {
        await this.reply(accountId, event, IDENTITY_TEXT);
        completed = true;
        return null;
      }
      if (event.chatType === 'group' && !event.isInAtList) {
        console.info(`钉钉群消息未 @ 本机器人, bot=${accountId}, messageId=${event.messageId}`);
        completed = true;
        return null;
      }
      const userId = await this.options.resolveUserId?.(accountId, event) ?? null;
      if (event.chatType === 'group' && event.isInAtList && messageService != null) {
        await messageService.recordGroupInbound(accountId, event);
      }
      if (userId == null) {
        await this.sendBindingGuide(accountId, event);
        completed = true;
        return null;
      }
      if (event.chatType === 'group' && messageService != null) {
        await this.options.rememberMember?.(accountId, event, userId);
      }
      const unsupported = isUnsupportedMedia(event);
      if (unsupported != null) {
        await this.reply(accountId, event, unsupported === 'group' ? GROUP_UNSUPPORTED_TEXT : P2P_UNSUPPORTED_TEXT);
        completed = true;
        return null;
      }
      entry = { accountId, event, userId, arrivalSeq };
      return entry;
    } finally {
      // 仅「未产出条目」（早返/异常）时在此收尾 claim；触发类条目的收尾随 flush 后移。
      if (entry == null && messageService != null) {
        if (completed) await messageService.completeInbound(accountId, event.messageId);
        else await messageService.releaseInbound(accountId, event.messageId);
      }
    }
  }

  /** 窗口 flush 入口：批内条目合并为一次触发，随后逐条 complete/release claim（与单条 finally 语义一致）。 */
  private async flushEntries(batch: DingtalkWindowEntry[]): Promise<void> {
    const messageService = this.options.messageService;
    let completed = false;
    try {
      await this.triggerMerged(batch);
      completed = true;
    } finally {
      if (messageService != null) {
        for (const entry of batch) {
          try {
            if (completed) await messageService.completeInbound(entry.accountId, entry.event.messageId);
            else await messageService.releaseInbound(entry.accountId, entry.event.messageId);
          } catch (error) {
            console.warn(`钉钉入站 claim 收尾失败, messageId=${entry.event.messageId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }
  }

  /** 合并触发：批内条目按到达序合并为一个 InboundContext，handler.onMessage ×1。
   *  身份字段（senderUserid/senderUnionId/senderName/msgtype 等）取首条（同键同发送者本一致）；
   *  正文与引用按到达序空行拼接；群上下文排除批内全部消息（各条 prepare 时已落日志），避免重复出现。 */
  private async triggerMerged(entries: DingtalkWindowEntry[]): Promise<void> {
    const first = entries[0].event;
    const accountId = entries[0].accountId;
    const userId = entries[0].userId;
    const text = entries.map((e) => e.event.text).filter((t) => t.trim() !== '').join('\n\n') || first.text;
    const quoted = entries.map((e) => e.event.quotedText?.trim() ?? '').filter((q) => q !== '').join('\n\n');
    const quotedText = quoted === '' ? null : quoted;
    let groupContext = '';
    const messageService = this.options.messageService;
    if (first.chatType === 'group' && messageService != null && !isInboundFileMessage(first)) {
      groupContext = await messageService.buildGroupContext(
        accountId, first.conversationId, entries.map((e) => e.event.messageId),
      );
    }
    const context: DingtalkInboundContext = {
      ...first,
      accountId,
      maoUserId: userId,
      groupContext,
      senderLabel: first.senderName,
      text,
      quotedText,
    };
    await this.handler.onMessage(context);
  }

  /** 窗口键 = 账号 + 会话 + 发送者：只合同一发送者在同一会话内的连续消息。 */
  private windowKeyOf(entry: DingtalkWindowEntry): string {
    return [entry.accountId, entry.event.conversationId, entry.event.senderUserid ?? ''].join(':');
  }

  /** 准入：仅文本类且会触发的消息入窗。豁免：语音/视频/文件、带图富文本、p2p `---` 新建会话。 */
  private canJoinEntry(entry: DingtalkWindowEntry): boolean {
    const event = entry.event;
    if (!JOINABLE_MSGTYPES.has(event.msgtype)) return false;
    // 带 downloadCode 的富文本内嵌图片：媒体不跨消息合并，整体豁免。
    if (event.downloadCodes.length > 0) return false;
    // `---` 新建会话（p2p 专属）：混入批次会让指令失效或错位。
    if (event.chatType === 'p2p' && isNewSessionCommand(event.text)) return false;
    return true;
  }

  private async sendBindingGuide(accountId: string, event: DingtalkNormalizedMessage): Promise<void> {
    if (this.options.oauthConfigured != null && !this.options.oauthConfigured()) {
      await this.reply(accountId, event, OAUTH_MISSING_TEXT);
      return;
    }
    const sent = await this.options.sendBindingCard?.(accountId, event) ?? false;
    if (!sent) await this.reply(accountId, event, OAUTH_MISSING_TEXT);
  }

  private async reply(accountId: string, event: DingtalkNormalizedMessage, text: string): Promise<void> {
    await this.options.sendReply?.(accountId, event, text);
  }
}

export { IDENTITY_TEXT, OAUTH_MISSING_TEXT, GROUP_UNSUPPORTED_TEXT, P2P_UNSUPPORTED_TEXT };
