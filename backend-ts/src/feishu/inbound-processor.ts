import type { FeishuInboundHandler, FeishuNormalizedMessage, FeishuInboundContext, FeishuReply } from './types.js';
import { inboundImageKeys, isInboundFileMessage } from './event-normalizer.js';
import type { FeishuMessageService } from './message.service.js';
import { botSenderLabel, isBotSender } from './message.service.js';
import { describeMessageText, FEISHU_CARD_UPGRADE_FALLBACK } from './message-detail.js';

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
}

export class FeishuInboundProcessor {
  constructor(private readonly handler: FeishuInboundHandler, private readonly options: FeishuInboundProcessorOptions = {}) {}

  /** 同群保序门闩：群消息「写入日志」与触发时「读取上下文」必须按到达顺序执行，
   * 防止并发入站处理乱序（图片尚未入库、水位线已被触发推进，导致该消息永远进不了上下文）。 */
  private readonly chatOrderQueues = new Map<string, Promise<unknown>>();

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

  async process(accountId: string, event: FeishuNormalizedMessage, skipClaim = false): Promise<void> {
    if (event.senderId == null || event.messageId == null) return;
    // 媒体消息（图片/文件）无文本时生成标注文本，避免空消息进入链路且群日志内容为空。
    const normalized = this.normalizeText(event);
    const messageId = normalized.messageId!;
    const messageService = this.options.messageService;
    const claimed = skipClaim || messageService == null
      ? true
      : await messageService.claimInboundMessage(accountId, { ...normalized, accountId, messageId });
    if (messageService != null && !claimed) return;
    let completed = false;
    try {
      if (normalized.chatType === 'p2p') {
        const named = await this.resolveSenderName(normalized, accountId);
        if (this.options.authorizeSender != null && !(await this.options.authorizeSender(accountId, named))) {
          await this.sendUnauthorizedGuide(accountId, named);
        } else if (this.handler.authorizeDirectMessage(accountId, named.senderUnionId ?? named.senderId!, named.text)) {
          const resolvedUserId = await this.options.resolveUserId?.(accountId, named);
          const expanded = await this.expandMergeForwardText(accountId, named);
          const quotedContext = await this.resolveQuoted(accountId, expanded);
          const reply = await this.handler.onMessage({ ...expanded, accountId, maoUserId: resolvedUserId ?? undefined, quotedContext });
          if (reply?.text) await this.sendReply(accountId, expanded, reply);
        }
        completed = true;
        return;
      }
      if (normalized.chatType !== 'group' || messageService == null) {
        completed = true;
        return;
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
        void this.enrichGroupMessage(accountId, logId, normalized);
        completed = true;
        return;
      }
      const mergeForward = normalized.messageType === 'merge_forward';
      try {
        let named = await this.resolveSenderName(normalized, accountId);
        // 未绑定用户不拉子消息。会触发的合并转发必须在 onMessage 之前展开，用户消息用摘录。
        if (!mergeForward) void this.enrichGroupMessage(accountId, logId, named);
        if (this.options.authorizeSender != null && !(await this.options.authorizeSender(accountId, named))) {
          if (mergeForward) void this.enrichGroupMessage(accountId, logId, named, { skipMergeForward: true });
          await this.sendUnauthorizedGuide(accountId, named);
          completed = true;
          return;
        }
        if (mergeForward) named = await this.persistExpandedMergeForward(accountId, logId, named);
        const resolvedUserId = await this.options.resolveUserId?.(accountId, named);
        // 纯文件：只下载并交给 handler 落库，不拼群上下文、不触发任务（飞书文件与文字分两条消息）。
        if (isInboundFileMessage(named)) {
          const quotedContext = await this.resolveQuoted(accountId, named);
          const fileContext: FeishuInboundContext = {
            ...named, accountId, messageId, maoUserId: resolvedUserId ?? undefined,
            senderLabel: this.options.senderLabel?.(named) ?? defaultSenderLabel(named),
            quotedContext,
          };
          await this.runInChatOrder(accountId, named.chatId, () => this.handler.onMessage(fileContext));
          completed = true;
          return;
        }
        // 同群内上下文读取排在更早消息的入库之后（runInChatOrder 保序），保证图片等先到消息已可见。
        const group = await this.runInChatOrder(accountId, named.chatId,
          () => messageService.buildGroupContext(accountId, { ...named, accountId, messageId, maoUserId: resolvedUserId ?? undefined }));
        const quotedContext = await this.resolveQuoted(accountId, named);
        const context: FeishuInboundContext = {
          ...named, accountId, messageId, maoUserId: resolvedUserId ?? undefined, groupContext: group.prompt,
          senderLabel: this.options.senderLabel?.(named) ?? defaultSenderLabel(named),
          quotedContext,
        };
        const reply = await this.handler.onMessage(context);
        if (reply?.text) await this.sendReply(accountId, named, reply);
        completed = true;
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
      if (messageService != null) {
        if (completed) await messageService.completeInboundMessage(accountId, messageId);
        else await messageService.releaseInboundMessage(accountId, messageId);
      }
    }
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

  /** 合并转发替换正文。失败、空结果或未配置展开函数时保持原文本。 */
  private async expandMergeForwardText(accountId: string, event: FeishuNormalizedMessage): Promise<FeishuNormalizedMessage> {
    if (event.messageType !== 'merge_forward' || event.messageId == null || this.options.expandMergeForward == null) return event;
    try {
      const workspace = this.options.resolveMergeWorkspace != null
        ? await this.options.resolveMergeWorkspace(accountId, event)
        : null;
      const excerpt = await this.options.expandMergeForward(accountId, event.messageId, workspace);
      if (excerpt == null || excerpt.trim() === '') return event;
      return { ...event, text: excerpt };
    } catch (error) {
      console.warn(`展开飞书合并转发失败, messageId=${event.messageId}: ${error instanceof Error ? error.message : String(error)}`);
      return event;
    }
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
