/* eslint-disable @typescript-eslint/no-explicit-any */
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Db } from './db/db.js';
import type { AppConfig } from './config/app-config.js';
import type { AppContext } from './create-app.js';
import type { MysqlFeishuMessageRepository } from './feishu/message.repository.js';
import type { FeishuMessageService } from './feishu/message.service.js';
import type { FeishuClientHelper } from './feishu-client.js';
import type { HarnessService } from './harness/core/harness-service.js';
import type { AgentLoop } from './harness/core/agent-loop.js';

import { createFeishuSessionHelper } from './feishu-session.js';
import { FEISHU_ECP_IDENTITY_MISMATCH_TEXT } from './feishu/ecp-inbound-gate.js';
import { createFeishuQueueCardHelper } from './feishu-cards.js';
import { createFeishuSessionUrlHelper } from './feishu-session.js';
import { MysqlFeishuCardSnapshotRepository } from './feishu/card-snapshot.repository.js';
import { MysqlFeishuProgressCardRepository } from './feishu/progress-card.repository.js';
import { createPatchedProgressHelper } from './feishu-cards.js';
import { createFeishuProgressCardHelper } from './feishu-cards.js';
import { createFeishuRoundOffsetHelper } from './feishu-client.js';
import { createFeishuRecoveryProgressHelper } from './feishu-cards.js';
import { createFeishuUserIdHelper } from './feishu-session.js';
import { FeishuInboundQueueRepository } from './feishu/inbound-queue.repository.js';
import { FeishuTaskQueueService } from './feishu/inbound-queue.service.js';
import { createQueuePositionHelper } from './app-utils.js';
import { createPersistCancelledHelper } from './app-utils.js';
import { AgentFeishuInboundHandler } from './feishu/agent-inbound-handler.js';
import { channelAssistantReply } from './session/util/citation-markers.js';
import { wsEvent } from './session/ws/ws-event.js';
import { WsStreamingEventListener } from './session/ws/ws-streaming-event-listener.js';
import { buildFeishuProgressCard } from './feishu/progress-card.js';
import { feishuSendTargetOf } from './feishu/media-sender.js';
import { createFeishuMediaHelper, IMAGE_EXT_BY_CONTENT_TYPE } from './feishu-media.js';
import { sanitizeFeishuFileName, downloadFeishuMediaBuffer, dataUriOf } from './feishu-media.js';
import { createThreadSessionHelper } from './feishu-session.js';
import { FeishuInboundProcessor } from './feishu/inbound-processor.js';
import { createResolveQuotedMessageHelper } from './feishu-session.js';
import { createResolveMessageTextHelper } from './feishu-media.js';
import { createResolveUserIdHelper } from './feishu-session.js';
import { createAuthorizeSenderHelper } from './feishu-session.js';
import { createSendUnauthorizedCardHelper } from './feishu-cards.js';
import { createUnauthorizedTextHelper } from './feishu-cards.js';
import { FeishuCardActionService } from './feishu/card-action.service.js';
import { persistFeishuCancelIfIdle } from './feishu/cancel-running.js';
import { FEISHU_DISLIKE_SOURCE } from './feedback/feedback.repository.js';
import { inboundImageKeys } from './feishu/event-normalizer.js';
import { chatFilesDirOf, resolveChatFileTarget } from './feishu/chat-files.js';
import { parseSqlTimeMs } from './app-utils.js';
import { createDingtalkRuntime } from './dingtalk/runtime.js';
import { FeishuMonitorService } from './feishu/monitor.service.js';
import { AnalyticsService, AnalyticsDbStore } from './analytics/analytics.service.js';
import { StatisticsService, StatisticsDbStore } from './statistics/statistics.service.js';
import { AdminAnalyticsService, AdminAnalyticsDbStore } from './admin/admin-analytics.service.js';
import { McpServerValidatorImpl } from './agent/mcp-validator.js';
import { readFeishuDocMarkdown } from './feishu/doc-reader.js';
import { fetchFeishuMessageDetail } from './feishu/message-detail.js';
import { sendFeishuFile, sendFeishuImage } from './feishu/media-sender.js';

export interface FeishuHandlerDeps {
  db: Db;
  cfg: AppConfig;
  ctx: AppContext;
  /** 飞书消息层（app-feishu-messaging）先于 harness 装配，这里只做消费。 */
  feishuMessageRepository: MysqlFeishuMessageRepository;
  feishuMessageService: FeishuMessageService;
  getFeishuClient: FeishuClientHelper['getFeishuClient'];
  getFeishuChatTitle: FeishuClientHelper['getFeishuChatTitle'];
  sendFeishuText: FeishuClientHelper['sendFeishuText'];
  /** harness/agentLoop 已于本模块之前装配完成（钉钉运行时需要真实实例）。 */
  harness: HarnessService;
  agentLoop: AgentLoop;
  // 其余依赖仍以 any 透传，避免逐个下沉类型
  [key: string]: any;
}

export interface FeishuHandlerResult {
  feishuInboundHandler: AgentFeishuInboundHandler;
  feishuInboundProcessor: FeishuInboundProcessor;
  feishuCardActionService: FeishuCardActionService;
  feishuMonitor: FeishuMonitorService;
  dingtalk: any;
  feishuTaskQueue: FeishuTaskQueueService;
  feishuProgressCardRepo: MysqlFeishuProgressCardRepository;
  createFeishuRecoveryProgress: any;
  analyticsService: AnalyticsService;
  statisticsService: StatisticsService;
  adminAnalytics: AdminAnalyticsService;
  userToolStatsStore: AdminAnalyticsDbStore;
  mcpValidator: McpServerValidatorImpl;
}

export function assembleFeishuHandler(deps: FeishuHandlerDeps): FeishuHandlerResult {
  const d = deps as any;
  const { db, cfg, ctx } = d;

  const {
    feishuMessageRepository, feishuMessageService, getFeishuClient, getFeishuChatTitle, sendFeishuText,
  } = d;
  const feishuSenderNames = new Map<string, Promise<string | null>>();
  const { applyFeishuBotConfig, ensureFeishuSessionTitle } = createFeishuSessionHelper({
    feishuBots: d.feishuBots, sessionService: d.sessionService, sessionRepo: d.sessionRepo, agentService: d.agentService, modelService: d.modelService, getFeishuChatTitle,
  });
  ctx.notifyFeishuPendingMismatch = async (pending: any) => {
    await sendFeishuText(pending.appId, pending.event, FEISHU_ECP_IDENTITY_MISMATCH_TEXT);
  };
  const feishuQueueCard = createFeishuQueueCardHelper({ getFeishuClient, feishuMessageService });
  const resolveFeishuSessionDetailUrl = createFeishuSessionUrlHelper({ settingService: d.settingService });
  const feishuCardSnapshotRepo = new MysqlFeishuCardSnapshotRepository(db);
  const feishuProgressCardRepo = new MysqlFeishuProgressCardRepository(db);
  const createPatchedProgress = createPatchedProgressHelper({
    feishuActiveProgress: d.feishuActiveProgress, feishuAskFormStore: d.feishuAskFormStore, feishuCardSnapshotRepo, backgroundSubagentManager: d.backgroundSubagentManager, feedbackMessageLookup: d.feedbackMessageLookup,
  });
  const createFeishuProgressCard = createFeishuProgressCardHelper({
    getFeishuClient, feishuMessageService, feishuProgressCardRepo, resolveFeishuSessionDetailUrl, createPatchedProgress,
  });
  const resolveFeishuRoundOffset = createFeishuRoundOffsetHelper({ sessionService: d.sessionService });
  const createFeishuRecoveryProgress = createFeishuRecoveryProgressHelper({
    getFeishuClient, feishuProgressCardRepo, sessionService: d.sessionService, resolveFeishuSessionDetailUrl, resolveFeishuRoundOffset, createPatchedProgress,
  });
  const resolveFeishuUserId = createFeishuUserIdHelper({ feishuBinding: d.feishuBinding });
  const feishuInboundQueueRepo = new FeishuInboundQueueRepository(db);
  const feishuTaskQueue = new FeishuTaskQueueService(feishuInboundQueueRepo);
  const queuePositionOf = createQueuePositionHelper({ feishuInboundQueueRepo });
  const persistCancelledIfActive = createPersistCancelledHelper({ sessionService: d.sessionService, taskTerminal: d.taskTerminal, feishuProgressCardRepo });
  const feishuInboundHandler = new AgentFeishuInboundHandler({
    registry: d.wsRegistry,
    resolveStreamUserId: async (sessionId: number) => {
      const session = await d.sessionService.getSession(sessionId).catch(() => null);
      return session?.userId ?? null;
    },
    sessionService: {
      getOrCreateSession: async (accountId: any, context: any) => {
        const triggerUserId = await resolveFeishuUserId(accountId, context);
        const conversation = context.chatType === 'group'
          ? await feishuMessageService.getOrCreateGroup(accountId, context)
          : await feishuMessageService.getOrCreateP2p(accountId, context, triggerUserId);
        await applyFeishuBotConfig(conversation.sessionId, Number(accountId));
        void ensureFeishuSessionTitle(conversation.sessionId, Number(accountId), context);
        return { id: conversation.sessionId, workspace: conversation.workspace ?? null, executionUserId: triggerUserId ?? null };
      },
      saveUserMessage: async (sessionId: number, content: any, metadata: any) => { await d.sessionService.saveMessage(sessionId, 'USER', content, null, null, null, 0, null, metadata ?? null); },
      updatePhase: async (sessionId: number, phase: any) => { await d.sessionService.updatePhase(sessionId, phase); },
      cleanupIncompleteTail: async (sessionId: number) => d.sessionService.cleanupIncompleteTail(sessionId),
      getPhase: async (sessionId: number) => (await d.sessionService.getSession(sessionId))?.phase ?? null,
      getLatestAssistantReplyWithId: async (sessionId: number) => {
        const messages = await d.sessionService.getMessages(sessionId);
        let messageId: number | null = null;
        for (let i = messages.length - 1; i >= 0; i--) {
          if (messages[i].role === 'ASSISTANT') {
            messageId = messages[i].id ?? null;
            break;
          }
        }
        return { text: channelAssistantReply(messages, '抱歉，暂时无法生成回复。'), messageId };
      },
      getMessages: async (sessionId: number) => d.sessionService.getMessages(sessionId),
    },
    p2pSessionControl: {
      findActiveSession: async (accountId: any, context: any) => {
        const triggerUserId = await resolveFeishuUserId(accountId, context);
        const conversation = await feishuMessageService.findActiveP2p(accountId, context, triggerUserId);
        return conversation == null ? null : { id: conversation.sessionId };
      },
      createSession: async (accountId: any, context: any) => {
        const triggerUserId = await resolveFeishuUserId(accountId, context);
        if (triggerUserId == null) throw new Error(`飞书用户未绑定: ${context.senderId ?? ''}`);
        const conversation = await feishuMessageService.createP2pSession(accountId, context, triggerUserId);
        await applyFeishuBotConfig(conversation.sessionId, Number(accountId));
        return { id: conversation.sessionId };
      },
      switchSession: async (accountId: any, context: any, targetSessionId: number) => {
        const triggerUserId = await resolveFeishuUserId(accountId, context);
        if (triggerUserId != null) {
          const targetSession = await d.sessionRepo.findById(targetSessionId);
          if (targetSession == null || targetSession.userId !== triggerUserId) {
            console.warn(`飞书引用切换拒绝: 目标会话不存在或归属其他用户, sessionId=${targetSessionId}, trigger=${triggerUserId}`);
            return null;
          }
        }
        const conversation = await feishuMessageService.switchP2pSession(accountId, context, targetSessionId, triggerUserId);
        if (conversation == null) return null;
        await applyFeishuBotConfig(conversation.sessionId, Number(accountId));
        return { id: conversation.sessionId };
      },
      findSessionByMessageId: (accountId: any, messageId: any) => feishuMessageService.findP2pMessageSession(accountId, messageId),
      recordMessageMapping: (accountId: any, messageId: any, sessionId: number, direction: any) => feishuMessageService.recordP2pMessage(accountId, messageId, sessionId, direction),
      finalizeNewSessionTitle: async (sessionId: number, title: string) => {
        const channel = await feishuMessageService.findSessionChannel(sessionId);
        if (channel?.awaitingFirstMessageTitle !== 1) return false;
        const session = await d.sessionService.getSession(sessionId);
        if (session == null) return false;
        await feishuMessageService.clearAwaitingFirstMessageTitle(sessionId);
        if (session.title != null && session.title !== '飞书Bot会话') return false;
        await d.sessionRepo.updateFields(sessionId, { title });
        d.wsRegistry.send(session.userId!, wsEvent('session_title_updated', sessionId, {
          title,
          parentSessionId: session.parentSessionId ?? null,
          sessionType: session.sessionType ?? 'NORMAL',
        }));
        return true;
      },
      isAwaitingFirstMessageTitle: async (sessionId: number) =>
        (await feishuMessageService.findSessionChannel(sessionId))?.awaitingFirstMessageTitle === 1,
    },
    threadSessionControl: {
      findSession: async (accountId: any, context: any) => {
        const result = await feishuMessageService.findThreadSession(accountId, context.threadId);
        return result == null ? null : { sessionId: result.sessionId, rootMessageId: result.rootMessageId };
      },
      getOrCreateSession: async (accountId: any, context: any) => {
        const result = await feishuMessageService.getOrCreateThreadSession(accountId, context);
        if (result == null) return null;
        const triggerUserId = await resolveFeishuUserId(accountId, context);
        await applyFeishuBotConfig(result.sessionId, Number(accountId));
        return { sessionId: result.sessionId, rootMessageId: result.rootMessageId, workspace: result.workspace ?? null, executionUserId: triggerUserId ?? null };
      },
    },
    titleGenerator: {
      generate: (sessionId: number, text: string) => d.sessionTitleService.generateExternalTitle(sessionId, text),
    },
    onReply: async (context: any, text: string, sessionId?: number) => {
      const messageId = await sendFeishuText(Number(context.accountId), context, text);
      if (messageId != null && sessionId != null && context.chatType === 'p2p') {
        await feishuMessageService.recordP2pMessage(context.accountId, messageId, sessionId, 'OUT');
      }
      return messageId;
    },
    harnessService: { execute: (...args: any[]) => d.harness.execute(...args), prepareMessage: (...args: any[]) => d.harness.prepareMessage(...args) } as never,
    createCancelFlag: (sessionId: number) => d.agentLoop.registerCancelFlag(sessionId),
    releaseCancelFlag: (sessionId: number) => d.agentLoop.removeCancelFlag(sessionId),
    createProgressCard: (context: any, sessionId: number) => createFeishuProgressCard(context, sessionId),
    onInterruptRunning: (sessionId: number) => {
      d.agentLoop.requestCancel(sessionId);
      try { d.shellManager.closeByConversation(sessionId); } catch (error) {
        console.debug(`关闭飞书会话 Shell 失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      d.feishuAskFormStore.clearSession(sessionId);
      d.askUserQuestionsRegistry.failAllForSession(sessionId);
    },
    resolveIdleRunning: async (sessionId: number) => {
      if (d.agentLoop.getCancelFlag(sessionId) != null) return;
      await persistCancelledIfActive(sessionId);
    },
    queueService: feishuTaskQueue,
    createQueueCard: async (context: any, _queueId: any, sessionId: number) => feishuQueueCard(context, _queueId, await queuePositionOf(sessionId), sessionId),
    resolveBotId: (accountId: any) => Number(accountId),
    downloadMedia: async (context: any, workspace: string | null) => {
      const botId = Number(context.accountId);
      const client = await getFeishuClient(botId);
      if (client == null) return null;
      const inboundKeys = inboundImageKeys(context);
      const isMedia = inboundKeys.length > 0 || context.messageType === 'file' && context.fileKey != null;
      if (!isMedia || context.messageId == null) return null;
      const maxBytes = Math.max(1, cfg.feishu.bot.file.maxInboundFileMb) * 1024 * 1024;
      const images: string[] = [];
      const imagePaths: string[] = [];
      const filePaths: string[] = [];
      const errors: string[] = [];
      try {
        let imageIndex = 0;
        for (const imageKey of inboundKeys) {
          try {
            const { buffer, contentType } = await downloadFeishuMediaBuffer(client, context.messageId, imageKey, 'image', maxBytes);
            if (buffer.length === 0) {
              errors.push('图片（接收失败）');
              continue;
            }
            images.push(dataUriOf(contentType, buffer));
            if (workspace != null && workspace !== '') {
              try {
                const ext = IMAGE_EXT_BY_CONTENT_TYPE[contentType] ?? '.jpg';
                const dir = chatFilesDirOf(workspace);
                mkdirSync(dir, { recursive: true });
                const name = imageIndex === 0 ? `feishu-image-${context.messageId}${ext}` : `feishu-image-${context.messageId}-${imageIndex + 1}${ext}`;
                const target = resolve(dir, name);
                await writeFile(target, buffer);
                imagePaths.push(target);
              } catch (error) {
                console.warn(`飞书图片落盘失败（不影响直传）, bot=${botId}, messageId=${context.messageId}: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
            imageIndex++;
          } catch (error) {
            console.error(`飞书图片下载失败, bot=${botId}, messageId=${context.messageId}`, error);
            errors.push('图片（接收失败）');
          }
        }
        if (context.messageType === 'file' && context.fileKey != null) {
          if (workspace == null || workspace === '') {
            errors.push(context.fileName ?? '文件（接收失败）');
          } else {
            try {
              const { buffer } = await downloadFeishuMediaBuffer(client, context.messageId, context.fileKey, 'file', maxBytes);
              if (buffer.length === 0) {
                errors.push(context.fileName ?? '文件（接收失败）');
              } else {
                const fileName = sanitizeFeishuFileName(context.fileName, `feishu-${context.fileKey}`);
                const dir = chatFilesDirOf(workspace);
                mkdirSync(dir, { recursive: true });
                const target = resolveChatFileTarget(dir, fileName, context.messageId);
                await writeFile(target, buffer);
                filePaths.push(target);
              }
            } catch (error) {
              console.error(`飞书文件下载失败, bot=${botId}, messageId=${context.messageId}`, error);
              errors.push(context.fileName ?? '文件（接收失败）');
            }
          }
        }
      } finally { /* 下载失败已收集 errors */ }
      return { images, imagePaths, filePaths, errors };
    },
    listenerFactory: async (sessionId: number, context: any, executionId: any) => {
      const session = await d.sessionService.getSession(sessionId);
      const ownerUserId = session.userId!;
      return new WsStreamingEventListener({
        registry: d.wsRegistry,
        activityService: d.activityService as never,
        activityHeartbeat: d.activityHeartbeat,
        sessionTodoMapper: d.todoMapper,
        sessionService: d.sessionService as never,
      }, sessionId, ownerUserId, executionId, session.modelId != null && (await d.modelService.getModel(session.modelId))?.supportsVision === 1);
    },
    onExecutionFinished: async (sessionId: number, _context: any, executionId: any, phase: any, failureReason: any) => {
      const session = await d.sessionService.getSession(sessionId);
      await d.taskTerminal.finishExecution(sessionId, session.userId!, phase, executionId, failureReason);
      if (phase === 'FAILED') return;
      try { await feishuProgressCardRepo.deleteBySessionId(sessionId); } catch (error) {
        console.warn(`清理飞书进度卡片映射失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });
  d.scheduledService.setFeishuResultPusher(async (sessionId: number, text: string) => {
    const channel = await feishuMessageService.findSessionChannel(sessionId);
    if (channel == null) return;
    const client = await getFeishuClient(Number(channel.appId));
    if (client == null) return;
    const target = feishuSendTargetOf(channel.appId, channel.chatId);
    const data = {
      msg_type: 'interactive',
      content: JSON.stringify(buildFeishuProgressCard('COMPLETED', 0, text, [], undefined, undefined, await resolveFeishuSessionDetailUrl(sessionId))),
    };
    const threadRootMessageId = channel.chatType === 'group'
      ? await feishuMessageService.findThreadRootMessageId(sessionId)
      : null;
    const response = threadRootMessageId != null
      ? await client.im.v1.message.reply({ path: { message_id: threadRootMessageId }, data })
      : await client.im.v1.message.create({
        params: { receive_id_type: target.receiveIdType },
        data: { ...data, receive_id: target.receiveId },
      });
    const pushedMessageId = (response as { data?: { message_id?: string } }).data?.message_id ?? null;
    if (pushedMessageId != null && channel.chatType === 'p2p') {
      await feishuMessageService.recordP2pMessage(channel.appId, pushedMessageId, sessionId, 'OUT');
    }
  });
  const feishuMediaHelper = createFeishuMediaHelper({
    getFeishuClient,
    feishuSenderNames,
    feishuBinding: d.feishuBinding,
    feishuMessageRepository,
    userRepo: d.userRepo,
    workspaceRoot: cfg.app.harness.workspaceRoot,
    maxInboundFileMb: cfg.feishu.bot.file.maxInboundFileMb,
  });
  const { resolveFeishuSenderName, resolveFeishuUserNames, resolveMergeWorkspace, expandMergeForward, resolveQuotedWorkspace, downloadFeishuGroupImage, downloadFeishuImageTo, downloadFeishuGroupFile } = feishuMediaHelper;
  const threadSessionHelper = createThreadSessionHelper({ feishuMessageService });
  const feishuInboundProcessor = new FeishuInboundProcessor(feishuInboundHandler, {
    messageService: feishuMessageService,
    mergeWindowMs: cfg.feishu.bot.mergeWindowMs,
    resolveSenderName: resolveFeishuSenderName,
    downloadGroupImage: downloadFeishuGroupImage,
    downloadGroupFile: downloadFeishuGroupFile,
    resolveThreadSession: threadSessionHelper.resolveThreadSession,
    ensureThreadSession: threadSessionHelper.ensureThreadSession,
    resolveQuotedMessage: createResolveQuotedMessageHelper({
      getFeishuClient, feishuMessageRepository, resolveQuotedWorkspace, expandMergeForward,
    }),
    expandMergeForward,
    resolveMergeWorkspace,
    resolveMessageText: createResolveMessageTextHelper({ getFeishuClient }),
    resolveUserId: createResolveUserIdHelper({ feishuBinding: d.feishuBinding }),
    authorizeSender: createAuthorizeSenderHelper({ feishuBinding: d.feishuBinding, feishuMessageRepository, ecpAuth: d.ecpAuth, ecpSessionRepo: d.ecpSessionRepo }),
    sendReply: async (accountId: any, event: any, text: string) => { await sendFeishuText(Number(accountId), event, text); },
    sendUnauthorizedCard: createSendUnauthorizedCardHelper({ getFeishuClient, ecpAuth: d.ecpAuth, feishu: d.feishu, pendingBindingMessages: d.pendingBindingMessages }),
    unauthorizedText: createUnauthorizedTextHelper({ ecpAuth: d.ecpAuth }),
  });
  ctx.pendingBindingProcessor = feishuInboundProcessor;
  const feishuCardActionService = new FeishuCardActionService({
    queuePort: feishuTaskQueue,
    interrupt: (sessionId: number) => feishuInboundHandler.interrupt(sessionId),
    interruptAndDrain: (sessionId: number) => feishuInboundHandler.interruptAndDrain(sessionId),
    cancelRunning: async (sessionId: number) => {
      feishuInboundHandler.cancel(sessionId);
      return persistFeishuCancelIfIdle({
        sessionId,
        hadLoop: d.agentLoop.getCancelFlag(sessionId) != null,
        persistCancelledIfActive,
        drainNextIfPending: (id: number) => feishuInboundHandler.drainNextIfPending(id),
      });
    },
    toggleDislike: async (sessionId: number, cardMessageId: string | null) => {
      const session = await d.sessionService.getSession(sessionId).catch(() => null);
      if (session == null) return null;
      let messageId: number | undefined;
      if (cardMessageId != null) {
        const snapshot = await feishuCardSnapshotRepo.findByCardMessageId(cardMessageId).catch((error: any) => {
          console.warn(`飞书点踩查询卡片快照失败, cardMessageId=${cardMessageId}, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        });
        messageId = snapshot?.messageId;
      }
      const result = await d.feedbackService.toggleSessionDislike(session.userId, sessionId, FEISHU_DISLIKE_SOURCE, messageId);
      if (result == null) return null;
      if (cardMessageId == null) {
        d.feishuActiveProgress.current(sessionId)?.setDisliked(result.disliked);
      } else {
        d.feishuActiveProgress.setDislikedByCard(cardMessageId, result.disliked);
      }
      return result;
    },
    retryFailed: async (sessionId: number, cardMessageId: string) => {
      const mapping = await feishuProgressCardRepo.findBySessionId(sessionId);
      if (mapping == null) return { ok: false, reason: 'NO_PROGRESS' };
      return feishuInboundHandler.retryExecution(sessionId, async () => {
        const client = await getFeishuClient(mapping.botId);
        if (client == null) return null;
        const sender = mapping.senderOpenId ?? '';
        const sessionDetailUrl = await resolveFeishuSessionDetailUrl(sessionId);
        const session = await d.sessionService.getSession(sessionId).catch(() => null);
        const startedAtMs = parseSqlTimeMs(session?.startedAt) ?? Date.now();
        try {
          await feishuProgressCardRepo.upsert({
            sessionId,
            botId: mapping.botId,
            cardMessageId,
            chatType: mapping.chatType,
            chatId: mapping.chatId,
            senderOpenId: mapping.senderOpenId,
          });
        } catch (error) {
          console.warn(`飞书重试进度卡片映射刷新失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        }
        return createPatchedProgress(
          client, cardMessageId, sessionId,
          { sessionId, sender, botId: mapping.botId },
          startedAtMs, sessionDetailUrl,
          { content: '正在重试，请稍候…' },
          mapping.botId,
        );
      });
    },
    patchCard: async (botId: number, cardMessageId: string, card: any) => {
      const client = await getFeishuClient(botId);
      if (client == null) throw new Error(`飞书客户端不可用, botId=${botId}, cardMessageId=${cardMessageId}`);
      const response = await client.im.v1.message.patch({ path: { message_id: cardMessageId }, data: { content: JSON.stringify(card) } });
      if (response?.code !== 0) {
        throw new Error(`飞书卡片更新失败, code=${response?.code ?? 'missing'}, msg=${response?.msg ?? 'unknown'}`);
      }
    },
    sessionDetailUrl: (sessionId: number) => resolveFeishuSessionDetailUrl(sessionId),
    askForms: d.feishuAskFormStore,
    renderProgressCard: (sessionId: number) => d.feishuActiveProgress.render(sessionId),
    renderProgressCardByCard: (cardMessageId: string) => d.feishuActiveProgress.renderByCard(cardMessageId),
    rebuildCardFromSnapshot: async (sessionId: number, cardMessageId: string, disliked: boolean, sender: string) => {
      const snapshot = await feishuCardSnapshotRepo.findByCardMessageId(cardMessageId).catch((error: any) => {
        console.warn(`飞书点踩查询卡片快照失败, cardMessageId=${cardMessageId}, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      if (snapshot == null) return null;
      return buildFeishuProgressCard(
        'COMPLETED', snapshot.round, snapshot.content ?? '', [],
        { sessionId, sender }, snapshot.elapsedMs, await resolveFeishuSessionDetailUrl(sessionId), undefined, disliked,
      );
    },
    refreshProgress: (sessionId: number) => d.feishuActiveProgress.refresh(sessionId),
    completeAsk: (sessionId: number, requestId: string, resultJson: string) => d.askUserQuestionsRegistry.complete(sessionId, requestId, resultJson),
    notifyAskAnswered: (sessionId: number, requestId: string) => {
      d.treeSignalPublisher.publishForSession(sessionId);
      void d.localToolSessions.getUserIdForSession(sessionId).then((userId: number | null) => {
        if (userId != null) {
          d.wsRegistry.send(userId, wsEvent('ask_user_questions_cancelled', sessionId, { requestId }));
        }
      }).catch((error: any) => {
        console.warn(`飞书提问结果通知客户端失败, sessionId=${sessionId}`, error);
      });
    },
  });
  const dingtalk = createDingtalkRuntime({
    db,
    config: {
      enabled: cfg.dingtalk.enabled,
      appSecretKey: cfg.dingtalk.appSecretKey,
      reconcileIntervalMs: cfg.dingtalk.reconcileIntervalMs,
      reconnectBaseMs: cfg.dingtalk.reconnectBaseMs,
      reconnectMaxMs: cfg.dingtalk.reconnectMaxMs,
      maxConsecutiveFailures: cfg.dingtalk.maxConsecutiveFailures,
      oauth: cfg.dingtalk.oauth,
      progressCardTemplateId: cfg.dingtalk.progressCardTemplateId,
      queueCardTemplateId: cfg.dingtalk.queueCardTemplateId,
      replyMaxLength: cfg.dingtalk.replyMaxLength,
      groupContextMaxItems: cfg.dingtalk.groupContext.maxItems,
      groupContextMaxMinutes: cfg.dingtalk.groupContext.maxMinutes,
      mergeWindowMs: cfg.dingtalk.mergeWindowMs,
    },
    workspaceRoot: cfg.app.harness.workspaceRoot,
    jwt: d.jwt,
    permissionService: d.permissionService,
    sessionService: d.sessionService,
    sessionRepo: d.sessionRepo,
    harness: d.harness,
    agentLoop: d.agentLoop,
    wsRegistry: d.wsRegistry,
    agentService: d.agentService,
    modelService: d.modelService,
    userRepo: d.userRepo,
    settingService: d.settingService,
    taskTerminal: d.taskTerminal,
    activityService: d.activityService,
    activityHeartbeat: d.activityHeartbeat,
    todoMapper: d.todoMapper,
    shellManager: d.shellManager,
  });
  d.dingtalkMediaHolder.current = dingtalk.mediaSend;
  const feishuMonitor = new FeishuMonitorService(cfg.feishu.bot, d.feishuBots, feishuInboundProcessor, async (data: any) => feishuCardActionService.handle(data, ''));

  const analyticsService = new AnalyticsService(new AnalyticsDbStore(db));
  const statisticsService = new StatisticsService(new StatisticsDbStore(db));
  const adminAnalytics = new AdminAnalyticsService(statisticsService, new AdminAnalyticsDbStore(db));
  const userToolStatsStore = new AdminAnalyticsDbStore(db);
  const mcpValidator = new McpServerValidatorImpl(d.mcpServerLookup);

  return {
    feishuInboundHandler,
    feishuInboundProcessor,
    feishuCardActionService,
    feishuMonitor,
    dingtalk,
    feishuTaskQueue,
    feishuProgressCardRepo,
    createFeishuRecoveryProgress,
    analyticsService,
    statisticsService,
    adminAnalytics,
    userToolStatsStore,
    mcpValidator,
  };
}
