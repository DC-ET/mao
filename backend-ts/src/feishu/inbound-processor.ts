import type { FeishuInboundHandler, FeishuNormalizedMessage, FeishuInboundContext, FeishuReply } from './types.js';
import { inboundImageKeys, isInboundFileMessage } from './event-normalizer.js';
import { isNewSessionCommand } from './agent-inbound-handler.js';
import type { FeishuMessageService } from './message.service.js';
import { botSenderLabel, isBotSender } from './message.service.js';
import { describeMessageText, FEISHU_CARD_UPGRADE_FALLBACK } from './message-detail.js';
import { InboundMergeWindow } from '../common/inbound-merge-window.js';

/** 触发前同步补齐的待富化行上限：正常只有刚到达的一两条，上限只是防御僵死行拖慢触发。 */
const PENDING_FLUSH_LIMIT = 10;

/** 可并入合并窗口的消息类型；其余（image/file/sticker/audio/video 等）到达即冲刷窗口后单独处理。
 *  带内嵌图片的 post 也豁免（imageKeys 非空）：媒体不跨消息合并，Agent 仍可按 msg 占位懒加载。 */
const JOINABLE_MESSAGE_TYPES = new Set(['text', 'merge_forward', 'post', 'interactive']);

export interface FeishuInboundProcessorOptions {
  messageService?: FeishuMessageService;
  isBotMentioned?: (event: FeishuNormalizedMessage) => boolean;
  senderLabel?: (event: FeishuNormalizedMessage) => string;
  sendReply?: (accountId: string, event: FeishuNormalizedMessage, text: string) => Promise<void>;
  authorizeSender?: (accountId: string, event: FeishuNormalizedMessage) => Promise<boolean>;
  resolveUserId?: (accountId: string, event: FeishuNormalizedMessage) => Promise<number | null>;
  onUnauthorized?: (accountId: string, event: FeishuNormalizedMessage) => Promise<void>;
  sendUnauthorizedCard?: (accountId: string, event: FeishuNormalizedMessage) => Promise<boolean>;
  /** 未绑定/未授权时的引导文案；可包含绑定链接。 */
  unauthorizedText?: (accountId: string, event: FeishuNormalizedMessage) => Promise<string> | string;
  resolveSenderName?: (accountId: string, event: FeishuNormalizedMessage) => Promise<string | null>;
  /** 解析被引用/回复消息的内容文本（含 [引用消息] 前缀）；返回 null 表示无法解析。 */
  resolveQuotedMessage?: (accountId: string, event: FeishuNormalizedMessage) => Promise<string | null>;
  /** 群聊图片入站即下载（非懒加载）：按 imageKey 下载并返回落盘绝对路径嵌入占位文本；null/抛错表示失败，保留懒加载占位符。 */
  downloadGroupImage?: (accountId: string, event: FeishuNormalizedMessage, imageKey: string, index: number) => Promise<string | null>;
  /** 群聊文件入站即下载：返回落盘绝对路径嵌入占位文本；null/抛错保留懒加载占位符。 */
  downloadGroupFile?: (accountId: string, event: FeishuNormalizedMessage) => Promise<string | null>;
  /** 话题会话映射查询：threadId 存在且映射命中（机器人已在该话题中）时免 @ 触发。 */
  resolveThreadSession?: (accountId: string, event: FeishuNormalizedMessage) => Promise<{ sessionId: number } | null>;
  /** interactive 卡片入站占位升级：事件 content 被飞书降级时按 messageId 拉详情补真实文本；null/抛错保留占位。 */
  resolveMessageText?: (accountId: string, messageId: string) => Promise<string | null>;
  /**
   * 展开合并转发。返回 null 或空串表示失败，调用方保留固定英文。
   * workspace 为会话工作区；定位失败时传 null，只做字数截断。
   */
  expandMergeForward?: (accountId: string, messageId: string, workspace: string | null) => Promise<string | null>;
  /** 合并转发落盘用的会话工作区。群聊按 chatId，私聊按 private-{userId}；失败返回 null。 */
  resolveMergeWorkspace?: (accountId: string, event: FeishuNormalizedMessage) => Promise<string | null> | string | null;
  /** 入站防抖合并窗口时长（ms）。0 = 关闭：消息到达即单条触发，行为与加窗之前一致。 */
  mergeWindowMs?: number;
}

/**
 * 窗口条目：到达即完成重活（claim、群日志、富化登记、合并转发展开），
 * 只把 handler.onMessage 这一个触发点挂到窗口上；flush 时批内合并为一次触发。
 * kind='file' 为群聊纯文件（ingest-only，不触发任务），一律豁免出窗。
 */
interface FeishuWindowEntry {
  kind: 'trigger' | 'file';
  accountId: string;
  /** 已解析发送人名、（p2p）合并转发摘录替换后的事件。 */
  event: FeishuNormalizedMessage;
  senderLabel: string;
  maoUserId?: number;
  messageId: string;
  /** process() 入口同步分配的到达序号：保证合并顺序 = 到达顺序（prepare 耗时不同不会乱序）。 */
  arrivalSeq: number;
  /** 群日志行 ID（prepare 时落库）；p2p 无日志行为 undefined。
   *  触发前补齐待富化行时只等到此 ID 及更早的行：更晚的行属于后续触发，
   *  等它会把本批挂在后到消息的后台富化上，让后到消息的触发反超本批（合并顺序被破坏）。 */
  logId?: number;
}

export class FeishuInboundProcessor {
  /** 同群保序门闩：群消息「写入日志」与触发时「读取上下文」必须按到达顺序执行，
   * 防止并发入站处理乱序（图片尚未入库、水位线已被触发推进，导致该消息永远进不了上下文）。 */
  private readonly chatOrderQueues = new Map<string, Promise<unknown>>();

  /** 后台富化在飞行登记（logId → 富化 Promise）：触发路径据此等待而非重复展开。 */
  private readonly enrichments = new Map<number, Promise<void>>();

  /** process() 入口同步分配的到达序号（跨 bot 单调即可，窗口内只比较同键条目）。 */
  private arrivalSeqCounter = 0;

  /** 入站防抖合并窗口：windowMs=0 时所有消息走豁免路径单条触发，与现状恒等。 */
  private readonly window: InboundMergeWindow<FeishuWindowEntry>;

  constructor(private readonly handler: FeishuInboundHandler, private readonly options: FeishuInboundProcessorOptions = {}) {
    this.window = new InboundMergeWindow<FeishuWindowEntry>({
      windowMs: options.mergeWindowMs ?? 0,
      keyOf: (entry) => this.windowKeyOf(entry),
      dedupeKeyOf: (entry) => entry.messageId,
      canJoin: (entry) => this.canJoinEntry(entry),
      seqOf: (entry) => entry.arrivalSeq,
      onFlush: (batch) => this.flushEntries(batch),
    });
  }

  /** 关机时 best-effort 冲刷在途窗口（只保证触发启动，执行由停机收尾等待/标记）。 */
  async flushAll(): Promise<void> {
    await this.window.flushAll();
  }

  private runInChatOrder<T>(accountId: string, chatId: string | null, fn: () => Promise<T>): Promise<T> {
    const key = `${accountId}:${chatId ?? ''}`;
    const previous = this.chatOrderQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.chatOrderQueues.set(key, queued);
    return previous.then(fn).finally(() => {
      release();
      if (this.chatOrderQueues.get(key) === queued) this.chatOrderQueues.delete(key);
    });
  }

  /** 登记后台富化在飞行任务；完成（无论成败）后摘登记，供 flushPendingEnrichments 判断能否直接等待。 */
  private trackEnrichment(logId: number, enrichment: Promise<void>): void {
    this.enrichments.set(logId, enrichment);
    void enrichment.finally(() => {
      if (this.enrichments.get(logId) === enrichment) this.enrichments.delete(logId);
    }).catch(() => undefined);
  }

  /**
   * 入站主入口：prepare（到达即完成 claim/日志/富化登记/合并转发展开）→ 窗口 submit。
   * `bypassWindow` 供绑定后补投使用：不经过窗口，立即单条触发（与加窗前的补投行为一致）。
   */
  async process(accountId: string, event: FeishuNormalizedMessage, skipClaim = false, options: { bypassWindow?: boolean } = {}): Promise<void> {
    if (event.senderId == null || event.messageId == null) return;
    // 到达序号必须在任何 await 之前同步分配：prepare 耗时差异（合并转发展开是网络调用）
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
   * 到达即执行的重活（与加窗前一致）：claim → 姓名/授权/合并转发展开 → 群日志落库。
   * 产出窗口条目；不触发的分支（未授权/未@/空身份）在此完成 claim 收尾并返回 null。
   * 触发类条目的 claim 保留到 flush 触发返回后再 complete/release（状态机不变，时机随批次后移）。
   */
  private async prepareOne(
    accountId: string, event: FeishuNormalizedMessage, skipClaim: boolean, arrivalSeq: number,
  ): Promise<FeishuWindowEntry | null> {
    if (event.senderId == null || event.messageId == null) return null;
    // 媒体消息（图片/文件）无文本时生成标注文本，避免空消息进入链路且群日志内容为空。
    const normalized = this.normalizeText(event);
    const messageId = normalized.messageId!;
    const messageService = this.options.messageService;
    const claimed = skipClaim || messageService == null
      ? true
      : await messageService.claimInboundMessage(accountId, { ...normalized, accountId, messageId });
    if (messageService != null && !claimed) return null;
    let completed = false;
    let entry: FeishuWindowEntry | null = null;
    try {
      if (normalized.chatType === 'p2p') {
        const named = await this.resolveSenderName(normalized, accountId);
        if (this.options.authorizeSender != null && !(await this.options.authorizeSender(accountId, named))) {
          await this.sendUnauthorizedGuide(accountId, named);
        } else if (this.handler.authorizeDirectMessage(accountId, named.senderUnionId ?? named.senderId!, named.text)) {
          const resolvedUserId = await this.options.resolveUserId?.(accountId, named);
          const expanded = await this.expandMergeForwardText(accountId, named);
          entry = {
            kind: 'trigger', accountId, event: expanded,
            senderLabel: this.options.senderLabel?.(expanded) ?? defaultSenderLabel(expanded),
            maoUserId: resolvedUserId ?? undefined, messageId, arrivalSeq,
          };
          return entry;
        }
        completed = true;
        return null;
      }
      if (normalized.chatType !== 'group' || messageService == null) {
        completed = true;
        return null;
      }
      let mentioned = this.isBotMentioned(normalized);
      // 话题消息免 @ 触发：仅当话题会话映射已存在（机器人已在该话题中）时放行。
      // 新话题（无映射）不 @ 不触发——用户开话题不等于让机器人参与；
      // @bot 时 mentioned 已为 true，正常走触发链路，agent handler 创建新话题会话。
      if (!mentioned && normalized.threadId != null && this.options.resolveThreadSession != null) {
        const threadSession = await this.options.resolveThreadSession(accountId, normalized).catch(() => null);
        if (threadSession != null) mentioned = true;
      }
      // 群消息立即按到达顺序落日志（占位文本），慢操作（姓名解析/图片预下载）后置为异步富化。
      // 需要富化的媒体/卡片/合并转发行落 enrich_pending=1：水位线不得越过未富化行，
      // 否则下载或展开期间后续 @ 触发会推进水位线，回填后的内容永远进不了 Agent 会话。
      const needsEnrich = inboundImageKeys(normalized).length > 0
        || isInboundFileMessage(normalized)
        || normalized.messageType === 'interactive'
        || normalized.messageType === 'merge_forward';
      const logId = await this.runInChatOrder(accountId, normalized.chatId,
        () => messageService.recordGroupMessage(accountId, { ...normalized, accountId }, mentioned, { enrichPending: needsEnrich }));
      if (!mentioned) {
        this.trackEnrichment(logId, this.enrichGroupMessage(accountId, logId, normalized));
        completed = true;
        return null;
      }
      const mergeForward = normalized.messageType === 'merge_forward';
      try {
        let named = await this.resolveSenderName(normalized, accountId);
        // 未绑定用户不拉子消息。会触发的合并转发必须在 onMessage 之前展开，用户消息用摘录。
        if (!mergeForward) this.trackEnrichment(logId, this.enrichGroupMessage(accountId, logId, named));
        if (this.options.authorizeSender != null && !(await this.options.authorizeSender(accountId, named))) {
          if (mergeForward) this.trackEnrichment(logId, this.enrichGroupMessage(accountId, logId, named, { skipMergeForward: true }));
          await this.sendUnauthorizedGuide(accountId, named);
          completed = true;
          return null;
        }
        if (mergeForward) named = await this.persistExpandedMergeForward(accountId, logId, named);
        const resolvedUserId = await this.options.resolveUserId?.(accountId, named);
        entry = {
          // 纯文件：只下载并交给 handler 落库，不拼群上下文、不触发任务（飞书文件与文字分两条消息）。
          kind: isInboundFileMessage(named) ? 'file' : 'trigger', accountId, event: named,
          senderLabel: this.options.senderLabel?.(named) ?? defaultSenderLabel(named),
          maoUserId: resolvedUserId ?? undefined, messageId, arrivalSeq, logId,
        };
        return entry;
      } catch (error) {
        // 授权或后续步骤抛错时，合并转发还没进 enrich 的 finally，必须在这里放行水位线。
        if (mergeForward) {
          try {
            await messageService.markGroupMessageEnriched(logId);
          } catch (markError) {
            console.warn(`飞书群消息富化完成标记失败, logId=${logId}: ${markError instanceof Error ? markError.message : String(markError)}`);
          }
        }
        throw error;
      }
    } finally {
      // 仅「未产出条目」（早返/异常）时在此收尾 claim；触发类条目的收尾随 flush 后移。
      if (entry == null && messageService != null) {
        if (completed) await messageService.completeInboundMessage(accountId, messageId);
        else await messageService.releaseInboundMessage(accountId, messageId);
      }
    }
  }

  /** 窗口 flush 入口：合并批内条目为一次触发，随后逐条 complete/release claim（与单条 finally 语义一致）。 */
  private async flushEntries(batch: FeishuWindowEntry[]): Promise<void> {
    const messageService = this.options.messageService;
    let completed = false;
    try {
      // file 条目一律豁免出窗（单条到达）；此处防御性分流，避免混合批次漏处理。
      for (const entry of batch) {
        if (entry.kind === 'file') await this.triggerFile(entry);
      }
      const triggers = batch.filter((entry) => entry.kind === 'trigger');
      if (triggers.length > 0) await this.triggerMerged(triggers);
      completed = true;
    } finally {
      if (messageService != null) {
        for (const entry of batch) {
          try {
            if (completed) await messageService.completeInboundMessage(entry.accountId, entry.messageId);
            else await messageService.releaseInboundMessage(entry.accountId, entry.messageId);
          } catch (error) {
            console.warn(`飞书入站 claim 收尾失败, messageId=${entry.messageId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }
  }

  /** 合并触发：批内条目按到达序合并为一个 InboundContext，handler.onMessage ×1。
   *  身份字段（messageId/parentId/rootId/threadId/senderLabel/maoUserId）取首条（同键同发送者本一致）；
   *  正文与 quotedContext 按到达序空行拼接；群上下文以末条 messageId 读一次（各条 prepare 时已落日志）。 */
  private async triggerMerged(entries: FeishuWindowEntry[]): Promise<void> {
    const first = entries[0];
    const last = entries[entries.length - 1];
    const accountId = first.accountId;
    const text = entries.map((e) => e.event.text).filter((t) => t.trim() !== '').join('\n\n') || first.event.text;
    const quotedParts = await Promise.all(entries.map((e) => this.resolveQuoted(accountId, e.event)));
    const quoted = quotedParts.filter((q): q is string => q != null && q.trim() !== '').join('\n\n');
    const quotedContext = quoted === '' ? undefined : quoted;
    if (first.event.chatType === 'p2p') {
      const context: FeishuInboundContext = {
        ...first.event, accountId, maoUserId: first.maoUserId, text, quotedContext,
      };
      const reply = await this.handler.onMessage(context);
      if (reply?.text) await this.sendReply(accountId, first.event, reply);
      return;
    }
    const messageService = this.options.messageService!;
    // 同群内上下文读取排在更早消息的入库之后（runInChatOrder 保序），保证图片等先到消息已可见。
    // 读之前先同步补齐待富化行：后台富化与触发读取存在竞态——用户「先转发记录、马上 @ 机器人」时，
    // buildGroupContext 会在 enrich_pending 行处截断，本轮 prompt 完全拿不到转发摘录，
    // 而用户往往不会有下一轮触发来补（水位线未推进，内容只会原样留在日志行里）。
    // 只补齐到本批末条消息为止：更晚的行属于后续触发，等它会让本批被后到的豁免消息反超。
    const upToLogId = entries.reduce((max, e) => Math.max(max, e.logId ?? 0), 0);
    await this.flushPendingEnrichments(accountId, last.event, upToLogId > 0 ? upToLogId : undefined);
    const group = await this.runInChatOrder(accountId, first.event.chatId,
      () => messageService.buildGroupContext(accountId, { ...last.event, accountId, messageId: last.messageId, maoUserId: last.maoUserId }));
    const context: FeishuInboundContext = {
      ...first.event, accountId, messageId: first.messageId, maoUserId: first.maoUserId, text,
      groupContext: group.prompt, senderLabel: first.senderLabel, quotedContext,
    };
    const reply = await this.handler.onMessage(context);
    if (reply?.text) await this.sendReply(accountId, first.event, reply);
  }

  /** 群聊纯文件豁免路径：下载并交给 handler 落库，不拼群上下文、不触发任务（与加窗前一致）。 */
  private async triggerFile(entry: FeishuWindowEntry): Promise<void> {
    const quotedContext = await this.resolveQuoted(entry.accountId, entry.event);
    const fileContext: FeishuInboundContext = {
      ...entry.event, accountId: entry.accountId, messageId: entry.messageId,
      maoUserId: entry.maoUserId, senderLabel: entry.senderLabel, quotedContext,
    };
    if (entry.event.chatType === 'group' && entry.event.chatId != null) {
      await this.runInChatOrder(entry.accountId, entry.event.chatId, () => this.handler.onMessage(fileContext));
      return;
    }
    await this.handler.onMessage(fileContext);
  }

  /** 窗口键 = 账号 + 会话 +（群的）话题 + 发送者：只合同一发送者在同一会话（话题）内的连续消息。 */
  private windowKeyOf(entry: FeishuWindowEntry): string {
    const event = entry.event;
    return [entry.accountId, event.chatId ?? '', event.threadId ?? '', event.senderId ?? ''].join(':');
  }

  /** 准入：仅文本类且会触发的消息入窗。豁免：媒体/带图富文本、`---`、p2p 引用切换、群纯文件。 */
  private canJoinEntry(entry: FeishuWindowEntry): boolean {
    if (entry.kind !== 'trigger') return false;
    const event = entry.event;
    if (!JOINABLE_MESSAGE_TYPES.has(event.messageType)) return false;
    // 带内嵌图片的富文本（post）：媒体不跨消息合并，其 imageKeys 随首条字段合并会丢，整体豁免。
    if (inboundImageKeys(event).length > 0) return false;
    // `---` 新建会话（p2p 专属）与 p2p 引用切换：混入批次会让指令/指针切换失效或错位。
    if (isNewSessionCommand(event.text)) return false;
    if (event.chatType === 'p2p' && event.parentId != null && event.parentId !== '') return false;
    return true;
  }

  private async resolveSenderName(event: FeishuNormalizedMessage, accountId: string): Promise<FeishuNormalizedMessage> {
    if (event.senderName != null && event.senderName.trim() !== '') return event;
    const name = await this.options.resolveSenderName?.(accountId, event);
    return name == null || name.trim() === '' ? event : { ...event, senderName: name };
  }

  /** 解析被引用/回复消息内容；失败降级为无引用（引用内容属任务意图核心，但不阻塞主流程）。 */
  private async resolveQuoted(accountId: string, event: FeishuNormalizedMessage): Promise<string | undefined> {
    if (event.parentId == null || event.parentId === '' || this.options.resolveQuotedMessage == null) return undefined;
    // 话题内回复：parent_id 恒指向话题根（官方行为），非用户主动引用 → 跳过注入。
    // 仅当 parent_id ≠ root_id 时才是显式引用了话题内某条回复。必须带 threadId 条件，
    // 否则非话题群普通引用回复（root_id 通常也等于 parent_id）会被误跳过。
    if (event.threadId != null && event.parentId === event.rootId) return undefined;
    try {
      const quoted = await this.options.resolveQuotedMessage(accountId, event);
      return quoted == null || quoted.trim() === '' ? undefined : quoted;
    } catch (error) {
      console.warn(`解析飞书引用消息失败, messageId=${event.messageId}, parentId=${event.parentId}: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /** 群消息后台富化（不阻塞入库与触发时序）：补齐发送人显示名；图片/文件消息入站预下载，
   * 成功则将日志行占位文本升级为携带 @{路径}@ 引用（Agent 免工具直接读取），失败保留懒加载占位符；
   * interactive 卡片事件 content 被飞书降级时，按 messageId 拉详情补真实文本；
   * 未触发的合并转发在此异步展开，回写摘录。触发路径不走这里，避免先清水位线再展开。 */
  private async enrichGroupMessage(
    accountId: string, logId: number, event: FeishuNormalizedMessage, options?: { skipMergeForward?: boolean },
  ): Promise<void> {
    const messageService = this.options.messageService;
    try {
      if (messageService == null || event.chatType !== 'group') return;
      const resolved = await this.resolveSenderName(event, accountId);
      if (resolved?.senderName != null && resolved.senderName.trim() !== '') {
        await messageService.updateGroupMessageSenderName(logId, resolved.senderName);
      }
      await this.prewarmGroupImage(accountId, logId, event);
      await this.prewarmGroupFile(accountId, logId, event);
      await this.prewarmGroupCardText(accountId, logId, event);
      if (options?.skipMergeForward !== true) await this.prewarmMergeForward(accountId, logId, event);
    } catch (error) {
      console.warn(`飞书群消息后台富化失败, messageId=${event.messageId}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // 无论富化成败都要放行水位线；失败时保留懒加载占位符，但不能永久卡住后续消息。
      try {
        await messageService?.markGroupMessageEnriched(logId);
      } catch (error) {
        console.warn(`飞书群消息富化完成标记失败, logId=${logId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** 触发前同步补齐范围内待富化行：合并转发行就地展开，其余类型等待已在飞行的后台富化。
   *  只在读取群上下文前调用；查询失败不阻塞触发（维持原有占位行为）。
   *  upToLogId 限定补齐范围（本批末条消息的日志行）：窗口期后到达的行不属于本次触发，
   *  等它的富化会把本次触发挂到后到消息上，破坏「先批后豁免」的顺序。 */
  private async flushPendingEnrichments(
    accountId: string, event: FeishuNormalizedMessage, upToLogId?: number,
  ): Promise<void> {
    const messageService = this.options.messageService;
    if (messageService == null || event.chatType !== 'group' || event.chatId == null || event.chatId === '') return;
    let pending: Array<{ id: number; messageId: string; msgType: string }>;
    try {
      pending = await messageService.listPendingGroupMessages(accountId, event.chatId, event.threadId ?? null, PENDING_FLUSH_LIMIT);
    } catch (error) {
      console.warn(`查询飞书待富化群消息失败, chatId=${event.chatId}: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const rows = upToLogId == null ? pending : pending.filter((row) => row.id <= upToLogId);
    for (const row of rows) {
      await this.flushPendingRow(accountId, event, row);
    }
  }

  private async flushPendingRow(accountId: string, event: FeishuNormalizedMessage, row: { id: number; messageId: string; msgType: string }): Promise<void> {
    const messageService = this.options.messageService;
    // 后台富化正在跑（并发入站的常态）：等它完成即可，不重复调展开/下载接口，
    // 也不能提前清 enrich_pending——水位线先越过该行后，后台回填的内容反而永远进不了上下文。
    const inFlight = this.enrichments.get(row.id);
    if (inFlight != null) {
      await inFlight;
      return;
    }
    // 只有合并转发行能仅凭 messageId 重建富化输入；图片/文件/卡片的富化输入（imageKey/fileKey/事件
    // content）不在日志行里，无在飞行任务时维持占位，由 Agent 经 feishu_download_file 懒加载兜底。
    if (row.msgType !== 'merge_forward') return;
    try {
      const excerpt = await this.mergeForwardExcerpt(accountId, event, row.messageId);
      if (excerpt != null && excerpt.trim() !== '') {
        await messageService?.updateGroupMessageContent(row.id, excerpt);
      }
    } catch (error) {
      console.warn(`触发前展开飞书合并转发失败, messageId=${row.messageId}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      // 与后台富化一致：无论成败都放行水位线，失败时保留占位文本，不永久卡住后续消息。
      try {
        await messageService?.markGroupMessageEnriched(row.id);
      } catch (error) {
        console.warn(`飞书群消息富化完成标记失败, logId=${row.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** 群图片预下载：成功回填日志行内容为本地路径引用；失败保留 msg 占位符走 feishu_download_file 懒加载兜底。
   *  独立图片消息整体替换占位文本；post 富文本（图片+文字）在原文后追加图片引用，保留文字内容。 */
  private async prewarmGroupImage(accountId: string, logId: number, event: FeishuNormalizedMessage): Promise<void> {
    const keys = inboundImageKeys(event);
    if (keys.length === 0 || this.options.downloadGroupImage == null) return;
    const refs: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      try {
        const path = await this.options.downloadGroupImage(accountId, event, keys[i], i);
        if (path != null && path !== '') refs.push(`@{${path}}@`);
      } catch (error) {
        console.warn(`飞书群图片预下载失败, messageId=${event.messageId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (refs.length === 0) return;
    const content = event.messageType === 'image'
      ? `[图片已保存: ${refs.join(' ')}]`
      : `${event.text}\n${refs.join('\n')}`;
    await this.options.messageService?.updateGroupMessageContent(logId, content);
  }

  /** 群文件预下载：成功回填日志行为本地路径引用；失败保留 msg 占位符走 feishu_download_file 懒加载兜底。 */
  private async prewarmGroupFile(accountId: string, logId: number, event: FeishuNormalizedMessage): Promise<void> {
    if (!isInboundFileMessage(event) || this.options.downloadGroupFile == null) return;
    try {
      const path = await this.options.downloadGroupFile(accountId, event);
      if (path == null || path === '') return;
      await this.options.messageService?.updateGroupMessageContent(logId, `[文件已保存: @{${path}}@]`);
    } catch (error) {
      console.warn(`飞书群文件预下载失败, messageId=${event.messageId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** 展开一条合并转发并返回摘录；未配置展开函数、调用失败或结果为空时返回 null（调用方保留固定英文）。 */
  private async mergeForwardExcerpt(accountId: string, event: FeishuNormalizedMessage, messageId: string): Promise<string | null> {
    if (this.options.expandMergeForward == null) return null;
    try {
      const workspace = this.options.resolveMergeWorkspace != null
        ? await this.options.resolveMergeWorkspace(accountId, event)
        : null;
      return await this.options.expandMergeForward(accountId, messageId, workspace);
    } catch (error) {
      console.warn(`展开飞书合并转发失败, messageId=${messageId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  /** 合并转发替换正文。失败、空结果或未配置展开函数时保持原文本。 */
  private async expandMergeForwardText(accountId: string, event: FeishuNormalizedMessage): Promise<FeishuNormalizedMessage> {
    if (event.messageType !== 'merge_forward' || event.messageId == null) return event;
    const excerpt = await this.mergeForwardExcerpt(accountId, event, event.messageId);
    if (excerpt == null || excerpt.trim() === '') return event;
    return { ...event, text: excerpt };
  }

  /** 会触发的群合并转发：展开后回写日志并放行水位线，返回带摘录的事件。失败也要清 enrich_pending。 */
  private async persistExpandedMergeForward(
    accountId: string, logId: number, event: FeishuNormalizedMessage,
  ): Promise<FeishuNormalizedMessage> {
    const messageService = this.options.messageService;
    let next = event;
    try {
      if (event.senderName != null && event.senderName.trim() !== '') {
        await messageService?.updateGroupMessageSenderName(logId, event.senderName);
      }
    } catch (error) {
      console.warn(`回填飞书发送人姓名失败, messageId=${event.messageId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      next = await this.expandMergeForwardText(accountId, event);
      if (next.text !== event.text) await messageService?.updateGroupMessageContent(logId, next.text);
    } catch (error) {
      console.warn(`展开飞书合并转发失败, messageId=${event.messageId}: ${error instanceof Error ? error.message : String(error)}`);
      next = event;
    } finally {
      try {
        await messageService?.markGroupMessageEnriched(logId);
      } catch (error) {
        console.warn(`飞书群消息富化完成标记失败, logId=${logId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return next;
  }

  /** 未触发的群合并转发：异步展开成功则回写摘录。水位线由 enrichGroupMessage 的 finally 放行。 */
  private async prewarmMergeForward(accountId: string, logId: number, event: FeishuNormalizedMessage): Promise<void> {
    if (event.messageType !== 'merge_forward') return;
    const expanded = await this.expandMergeForwardText(accountId, event);
    if (expanded.text === event.text) return;
    await this.options.messageService?.updateGroupMessageContent(logId, expanded.text);
  }

  /** interactive 卡片预升级：事件 content 被飞书降级为占位时，按 messageId 拉详情补真实文本。
   *  失败或仍无有效文本则保留已入库占位（[卡片消息]），不阻塞主流程。 */
  private async prewarmGroupCardText(accountId: string, logId: number, event: FeishuNormalizedMessage): Promise<void> {
    if (event.messageType !== 'interactive' || this.options.resolveMessageText == null || event.messageId == null) return;
    const current = (event.text ?? '').trim();
    // 事件自带真实卡片文本时无需回拉。
    if (current !== '' && current !== '[卡片消息]' && current !== FEISHU_CARD_UPGRADE_FALLBACK) return;
    try {
      const text = await this.options.resolveMessageText(accountId, event.messageId);
      const upgraded = (text ?? '').trim();
      if (upgraded === '' || upgraded === FEISHU_CARD_UPGRADE_FALLBACK) return;
      await this.options.messageService?.updateGroupMessageContent(logId, upgraded);
    } catch (error) {
      console.warn(`飞书卡片文本预升级失败, messageId=${event.messageId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private normalizeText(event: FeishuNormalizedMessage): FeishuNormalizedMessage {
    const rawText = event.text?.trim() ?? '';
    // 飞书卡片降级文案无信息量：视为空文本走占位/详情升级，避免落入群日志污染上下文。
    if (rawText !== '' && rawText !== FEISHU_CARD_UPGRADE_FALLBACK) return event;
    // 纯文本消息保持原样（空文本不应伪造占位符）；非文本消息统一生成占位/可读文本
    // （复用引用预取的映射，含 post 富文本、语音、视频、卡片等），占位符携带消息 ID，
    // 供 Agent 通过 feishu_download_file 按需下载。
    if (event.messageType === 'text') return event;
    const content: Record<string, unknown> = (event.content ?? {}) as Record<string, unknown>;
    // 归一化事件已提取的 file_name 优先于原始 content（测试与部分消息体可能缺失）。
    const payload = event.fileName != null && content.file_name == null ? { ...content, file_name: event.fileName } : content;
    let placeholder = describeMessageText(
      event.messageType,
      payload,
      event.messageId ?? '未知',
    ).trim();
    if (placeholder === '') placeholder = `[${event.messageType} msg=${event.messageId ?? '未知'}]`;
    return { ...event, text: placeholder };
  }

  private async sendUnauthorizedGuide(accountId: string, event: FeishuNormalizedMessage): Promise<void> {
    await this.options.onUnauthorized?.(accountId, event);
    let sentCard = false;
    try {
      sentCard = await this.options.sendUnauthorizedCard?.(accountId, event) ?? false;
    } catch (error) {
      console.warn(`飞书绑定卡片发送失败，使用文本回退: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!sentCard) await this.sendUnauthorized(accountId, event);
  }

  private async sendUnauthorized(accountId: string, event: FeishuNormalizedMessage): Promise<void> {
    const text = await this.options.unauthorizedText?.(accountId, event) ?? defaultUnauthorizedText(event);
    await this.sendReply(accountId, event, { text });
  }

  private async sendReply(accountId: string, event: FeishuNormalizedMessage, reply: FeishuReply): Promise<void> {
    await this.options.sendReply?.(accountId, event, reply.text ?? '');
  }

  private isBotMentioned(event: FeishuNormalizedMessage): boolean {
    return this.options.isBotMentioned?.(event) ?? event.isBotMentioned;
  }
}

function defaultSenderLabel(event: FeishuNormalizedMessage): string {
  if (event.senderName != null && event.senderName.trim() !== '') return event.senderName;
  if (isBotSender(event)) return botSenderLabel(event.senderId);
  const raw = event.rawEvent as Record<string, any>;
  return raw?.event?.sender?.sender_id?.name ?? raw?.event?.sender?.name ?? event.senderId ?? '未知用户';
}

function defaultUnauthorizedText(event: FeishuNormalizedMessage): string {
  return event.chatType === 'group'
    ? '请先完成飞书账号绑定，获得群内使用权限后再试。'
    : '请先完成飞书账号绑定后再试。';
}
