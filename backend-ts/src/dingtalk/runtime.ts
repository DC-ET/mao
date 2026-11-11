import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { decryptAesGcm } from '../crypto/aes-gcm.js';
import type { JwtService } from '../crypto/jwt.service.js';
import type { Db } from '../db/db.js';
import { chatFilesDirOf, resolveChatFileTarget } from '../feishu/chat-files.js';
import { createSessionDetailUrlResolver } from '../feishu/progress-card.js';
import type { FeishuCardProgress } from '../feishu/card-progress-listener.js';
import { countCompletedAgentRounds } from '../feishu/card-progress-listener.js';
import type { AgentLoop } from '../harness/core/agent-loop.js';
import type { HarnessService } from '../harness/core/harness-service.js';
import type { AgentService } from '../agent/agent.service.js';
import type { ModelService } from '../model/model.service.js';
import type { SessionRepository } from '../session/session.repository.js';
import type { DingtalkMediaSendSupport, DingtalkSendTarget } from '../harness/tool/impl/dingtalk-tools.js';
import { isDingtalkChannelSession } from '../harness/tool/dingtalk-channel-tool.js';
import type { SessionService } from '../session/session.service.js';
import { toStoredContentJson } from '../session/session-vo.js';
import { channelAssistantReply } from '../session/util/citation-markers.js';
import { WsStreamingEventListener } from '../session/ws/ws-streaming-event-listener.js';
import { registerDingtalkBotRoutes } from './admin.routes.js';
import { AgentDingtalkInboundHandler } from './agent-inbound-handler.js';
import { MysqlDingtalkBindingRepository } from './binding.repository.js';
import { registerDingtalkBindingRoutes } from './binding.routes.js';
import { MysqlDingtalkBotRepository } from './bot.repository.js';
import { persistDingtalkCancelIfIdle } from './cancel-running.js';
import { DingtalkCardActionService } from './card-action.service.js';
import { progressCardParams, queueCardParams } from './card-body.js';
import { createAndDeliverCard, updateCard } from './card-client.js';
import { DingtalkInboundProcessor } from './inbound-processor.js';
import { DingtalkInboundQueueRepository } from './inbound-queue.repository.js';
import { DingtalkTaskQueueService } from './inbound-queue.service.js';
import { downloadBytes, exchangeDownloadUrl, uploadMedia } from './media.js';
import { DingtalkMessageService } from './message.service.js';
import { MysqlDingtalkMessageRepository } from './message.repository.js';
import { DingtalkMonitorService, type DingtalkMonitorConfig, type DingtalkStreamClient } from './monitor.service.js';
import { MysqlDingtalkOauthStateRepository } from './oauth.repository.js';
import { dingtalkAuthorizeUrl, exchangeUserAccessToken, fetchUnionId, fetchUseridByUnionId, oauthConfigured, webOriginOf, type DingtalkOauthConfig } from './oauth-client.js';
import { MysqlDingtalkPendingBindingRepository } from './pending-binding.repository.js';
import { MysqlDingtalkProgressCardRepository } from './progress-card.repository.js';
import { deliverScheduledDingtalkReply } from './scheduled-result.js';
import { bindingCardParam, fileMessageParam, imageMessageParam, sendDingtalkMarkdown, sendDingtalkMessage, type DingtalkSendTarget as OutboundTarget } from './send.service.js';
import { DingtalkTokenCache } from './token.js';
import type { DingtalkBot, DingtalkInboundContext, DingtalkNormalizedMessage } from './types.js';
import { groupProjectKey, privateProjectKey, resolveDingtalkWorkspace } from './workspace.js';

export interface DingtalkRuntimeConfig extends DingtalkMonitorConfig {
  progressCardTemplateId: string;
  queueCardTemplateId: string;
  replyMaxLength: number;
  groupContextMaxItems: number;
  groupContextMaxMinutes: number;
  /** 入站防抖合并窗口（ms）；0=禁用。 */
  mergeWindowMs: number;
}

export interface DingtalkRuntime {
  registerRoutes(app: FastifyInstance): void;
  start(): void;
  shutdown(): void;
  /** 关机时 best-effort 冲刷在途合并窗口（只保证触发启动，执行由停机收尾等待/标记）。 */
  flushInbound(): Promise<void>;
  mediaSend: DingtalkMediaSendSupport;
  recoverProgress(sessionId: number): Promise<{ progress: FeishuCardProgress; roundOffset: number } | null>;
  onCrashFinished(sessionId: number, phase: string): Promise<void>;
  hydrate(): Promise<void>;
  /** WS 侧 message_queue 排空接力：消费钉钉入站队列（busy 入队消息）。 */
  drainNextIfPending(sessionId: number): Promise<void>;
  /** 供 WS autoConsume 的跨通道忙检查（同步、无副作用）。 */
  hasRunningSession(sessionId: number): boolean;
  /** 定时任务 / 无进度卡的恢复终态：把最终回复推回原钉钉会话。非钉钉会话直接返回。 */
  pushScheduledResult(sessionId: number, text: string): Promise<void>;
}

type StreamCtor = new (options: { clientId: string; clientSecret: string; keepAlive?: boolean }) => DingtalkStreamClient;

export function createDingtalkRuntime(deps: {
  db: Db;
  config: DingtalkRuntimeConfig;
  workspaceRoot: string;
  jwt: JwtService;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
  sessionService: SessionService;
  sessionRepo: SessionRepository;
  harness: HarnessService;
  agentLoop: AgentLoop;
  wsRegistry: { send(userId: number, event: unknown): void };
  agentService: AgentService;
  modelService: ModelService;
  userRepo: { findById(id: number): Promise<{ id?: number } | null> };
  settingService: {
    getSiteBaseUrl(): Promise<string | null>;
    /** 钉钉 OAuth 登录配置（V191）：实时读 system_setting，保存后即时生效。 */
    getDingtalkOauthConfig(): Promise<DingtalkOauthConfig>;
  };
  taskTerminal: { finishExecution(sessionId: number, userId: number, phase: string, executionId: string, failureReason?: string): Promise<void> };
  activityService: unknown;
  activityHeartbeat: unknown;
  todoMapper: unknown;
  shellManager: { closeByConversation(sessionId: number): void };
  /** 跨通道忙判定（WS 侧执行占用会话），透传给入站 handler 的 isSessionExecuting。 */
  isSessionExecuting?: (sessionId: number) => boolean;
  /** 入站队列排空且会话空闲时接力消费平台排队消息（message_queue），由装配层实现。 */
  onQueuesDrained?: (sessionId: number) => void;
  fetchImpl?: typeof fetch;
}): DingtalkRuntime {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const tokens = new DingtalkTokenCache(fetchImpl);
  const bots = new MysqlDingtalkBotRepository(deps.db);
  const binding = new MysqlDingtalkBindingRepository(deps.db);
  const oauthStates = new MysqlDingtalkOauthStateRepository(deps.db);
  const pending = new MysqlDingtalkPendingBindingRepository(deps.db);
  const messages = new MysqlDingtalkMessageRepository(deps.db);
  const messageService = new DingtalkMessageService(messages, {
    create: async (accountId, context) => {
      const bot = await bots.findById(Number(accountId));
      if (bot == null) throw new Error(`钉钉Bot不存在: ${accountId}`);
      const userId = context.maoUserId;
      if (userId == null) throw new Error('钉钉用户未绑定');
      const user = await deps.userRepo.findById(userId);
      if (user?.id == null) throw new Error('钉钉用户未绑定');
      const agent = bot.agentId != null ? await deps.agentService.getAgent(bot.agentId) : await deps.agentService.requireDefaultAgent();
      const model = bot.modelId != null ? await deps.modelService.getModel(bot.modelId) : await deps.modelService.getDefaultModel();
      if (agent?.id == null) throw new Error('钉钉机器人没有可用 Agent');
      const leaf = context.chatType === 'group' ? context.conversationId : `p2p-${user.id}`;
      const workspace = resolveDingtalkWorkspace(deps.workspaceRoot, accountId, leaf);
      mkdirSync(workspace, { recursive: true });
      const isGroup = context.chatType === 'group';
      const session = await deps.sessionService.createSession(
        user.id, agent.id, isGroup ? '钉钉群聊' : '钉钉会话', 'CLOUD', workspace, 'FULL', false,
        'linux', '/bin/bash', 'Linux', model?.id ?? null,
        isGroup ? groupProjectKey(accountId, context.conversationId) : privateProjectKey(accountId, user.id),
        'new', null, null, 'dingtalk',
      );
      return { sessionId: session.id!, ownerUserId: user.id, workspace: session.workspace };
    },
  }, deps.config.groupContextMaxItems, deps.config.groupContextMaxMinutes);
  const queueRepo = new DingtalkInboundQueueRepository(deps.db);
  const queue = new DingtalkTaskQueueService(queueRepo);
  const progressRepo = new MysqlDingtalkProgressCardRepository(deps.db);

  const credentialsOf = async (botId: number): Promise<{ bot: DingtalkBot; secret: string } | null> => {
    const bot = await bots.findById(botId);
    if (bot?.id == null || bot.enabled === 0 || !deps.config.appSecretKey) return null;
    return { bot, secret: decryptAesGcm(bot.clientSecret, deps.config.appSecretKey, '钉钉Bot clientSecret解密失败') };
  };

  const sessionDetailUrl = createSessionDetailUrlResolver({
    getSiteBaseUrl: () => deps.settingService.getSiteBaseUrl(),
  });

  const templateOf = (bot: DingtalkBot, kind: 'progress' | 'queue'): string | null => {
    const row = kind === 'progress' ? bot.progressCardTemplateId : bot.queueCardTemplateId;
    const env = kind === 'progress' ? deps.config.progressCardTemplateId : deps.config.queueCardTemplateId;
    const value = (row != null && row !== '' ? row : env).trim();
    return value === '' ? null : value;
  };

  const sendText = async (botId: number, event: Pick<DingtalkNormalizedMessage, 'chatType' | 'conversationId' | 'senderUserid'>, text: string): Promise<void> => {
    const cred = await credentialsOf(botId);
    if (cred == null) throw new Error('钉钉机器人不可用');
    const target: OutboundTarget = event.chatType === 'group'
      ? { chatType: 'group', robotCode: cred.bot.robotCode, conversationId: event.conversationId }
      : { chatType: 'p2p', robotCode: cred.bot.robotCode, userId: event.senderUserid ?? '' };
    const result = await sendDingtalkMarkdown({
      token: () => tokens.getAccessToken(cred.bot.clientId, cred.secret),
      fetchImpl,
    }, target, text, deps.config.replyMaxLength);
    if (!result.ok) throw new Error(result.reason);
    if (event.chatType === 'group') {
      await messageService.recordGroupOutbound(botId, event.conversationId, text).catch((error) => {
        console.warn(`钉钉群出站摘要写入失败, botId=${botId}`, error);
      });
    }
  };

  // 文本进度「正在处理」受理回执：粒度为「每次执行一次」——textProgress 对象由
  // createProgress 在每次执行开始时新建，局部 sent 标志保证同一次执行内只发一条。
  const textProgress = (botId: number, event: DingtalkInboundContext, sessionId: number): FeishuCardProgress => {
    let sent = false;
    return {
      update: async (status) => {
        if (status !== 'RUNNING' || sent) return;
        sent = true;
        await sendText(botId, event, '正在处理').catch((error) => console.warn(`钉钉文本进度发送失败, sessionId=${sessionId}`, error));
      },
    };
  };

  const cardProgress = (cred: { bot: DingtalkBot; secret: string }, outTrackId: string, sessionId: number, sender: string, startedAt: number): FeishuCardProgress => ({
    update: async (status, round, content, tools) => {
      const mapped = status === 'RUNNING' ? 'running' : status === 'COMPLETED' ? 'completed' : status === 'FAILED' ? 'failed' : 'cancelled';
      const params = progressCardParams({
        status: mapped,
        round,
        elapsedMs: mapped === 'running' ? undefined : Date.now() - startedAt,
        tools,
        // 正文全状态透传：running 是流式累积的 assistant 文本，终态是最终回复。
        // 此前只透传 failed/cancelled，导致完成卡只剩状态行、看不到结果全文。
        detail: content,
        sessionUrl: await sessionDetailUrl(sessionId),
        sessionId,
        senderUserid: sender,
      });
      await updateCard(fetchImpl, await tokens.getAccessToken(cred.bot.clientId, cred.secret), outTrackId, params);
    },
  });

  const createProgress = async (context: DingtalkInboundContext, sessionId: number): Promise<FeishuCardProgress | null> => {
    const botId = Number(context.accountId);
    const cred = await credentialsOf(botId);
    if (cred == null) return null;
    const templateId = templateOf(cred.bot, 'progress');
    const sender = context.senderUserid ?? '';
    if (templateId == null) return textProgress(botId, context, sessionId);
    const startedAt = Date.now();
    const params = progressCardParams({
      status: 'running', round: 0, detail: '任务已接收，正在准备执行。', sessionUrl: await sessionDetailUrl(sessionId), sessionId, senderUserid: sender,
    });
    const outTrackId = await createAndDeliverCard(fetchImpl, await tokens.getAccessToken(cred.bot.clientId, cred.secret), {
      chatType: context.chatType, senderUserid: sender, conversationId: context.conversationId, templateId, cardParamMap: params,
      robotCode: cred.bot.robotCode,
    });
    await progressRepo.upsert({
      sessionId, botId, outTrackId, chatType: context.chatType, conversationId: context.conversationId, senderUserid: sender,
    }).catch((error) => console.warn(`钉钉进度卡映射写入失败, sessionId=${sessionId}`, error));
    return cardProgress(cred, outTrackId, sessionId, sender, startedAt);
  };

  const handlerBox: { current: AgentDingtalkInboundHandler | null } = { current: null };
  const handler = new AgentDingtalkInboundHandler({
    registry: deps.wsRegistry as never,
    isSessionExecuting: deps.isSessionExecuting,
    onQueuesDrained: deps.onQueuesDrained,
    resolveStreamUserId: async (sessionId) => (await deps.sessionService.getSession(sessionId).catch(() => null))?.userId ?? null,
    sessionService: {
      getOrCreateSession: async (accountId, context) => {
        const owner = context.maoUserId;
        if (owner == null) throw new Error('钉钉用户未绑定');
        const conversation = await messageService.getOrCreate(accountId, context, owner);
        await applyBotConfig(conversation.sessionId, Number(accountId));
        return { id: conversation.sessionId, workspace: conversation.workspace ?? null, executionUserId: owner };
      },
      saveUserMessage: async (sessionId, content, metadata) => {
        const saved = await deps.sessionService.saveMessage(sessionId, 'USER', content, null, null, null, 0, null, metadata ?? null);
        return saved.id;
      },
      replaceMessageContent: async (messageId, content) => {
        const stored = typeof content === 'string' ? content : toStoredContentJson(content);
        await deps.db.execute('UPDATE `message` SET content = ? WHERE id = ?', [stored, messageId]);
      },
      updatePhase: (sessionId, phase) => deps.sessionService.updatePhase(sessionId, phase),
      cleanupIncompleteTail: (sessionId) => deps.sessionService.cleanupIncompleteTail(sessionId),
      getPhase: async (sessionId) => (await deps.sessionService.getSession(sessionId))?.phase ?? null,
      // 最近一次执行的运行身份（技术方案 2026-11-04 §5.2）：重试透传。
      // 不在此吞错：读取异常交给 runRetry 的 catch 记录并回落 owner，避免「身份漂移」静默复现。
      getLastRuntimeUserId: async (sessionId) =>
        (await deps.sessionService.getSession(sessionId))?.lastRuntimeUserId ?? null,
      getLatestAssistantReply: async (sessionId) => {
        const rows = await deps.sessionService.getMessages(sessionId);
        // 渠道不发桌面来源区，[^n^] 标记原样露出会像没渲染干净的模板变量，统一剥掉
        return channelAssistantReply(rows, '抱歉，暂时无法生成回复。');
      },
      getMessages: (sessionId) => deps.sessionService.getMessages(sessionId),
    },
    p2pSessionControl: {
      findActiveSession: async (accountId, context) => {
        const row = await messageService.findActive(accountId, context.conversationId);
        return row == null ? null : { id: row.sessionId };
      },
      createSession: async (accountId, context) => {
        if (context.maoUserId == null) throw new Error('钉钉用户未绑定');
        const conversation = await messageService.createP2pSession(accountId, context, context.maoUserId);
        await applyBotConfig(conversation.sessionId, Number(accountId));
        return { id: conversation.sessionId };
      },
      finalizeNewSessionTitle: async (sessionId, title) => {
        const session = await deps.sessionService.getSession(sessionId);
        if (session.title != null && session.title !== '钉钉会话') return false;
        await deps.sessionRepo.updateFields(sessionId, { title });
        return true;
      },
    },
    harnessService: deps.harness,
    createCancelFlag: (sessionId) => deps.agentLoop.registerCancelFlag(sessionId),
    releaseCancelFlag: (sessionId) => deps.agentLoop.removeCancelFlag(sessionId),
    onInterruptRunning: (sessionId) => {
      deps.agentLoop.requestCancel(sessionId);
      try { deps.shellManager.closeByConversation(sessionId); } catch { /* shell 可能不存在 */ }
    },
    settleCancel: async (sessionId) => {
      await persistDingtalkCancelIfIdle({
        sessionId,
        hadLoop: deps.agentLoop.getCancelFlag(sessionId) != null,
        persistCancelledIfActive,
        drainNextIfPending: (id) => handlerBox.current?.drainNextIfPending(id) ?? Promise.resolve(),
      });
    },
    resolveIdleRunning: async (sessionId) => {
      if (deps.agentLoop.getCancelFlag(sessionId) != null) return;
      await persistCancelledIfActive(sessionId);
    },
    queueService: queue,
    resolveBotId: (accountId) => Number(accountId),
    createProgressCard: createProgress,
    createQueueCard: async (context, queueId) => {
      const cred = await credentialsOf(Number(context.accountId));
      if (cred == null) return null;
      const templateId = templateOf(cred.bot, 'queue');
      if (templateId == null) return null;
      const sender = context.senderUserid ?? '';
      return createAndDeliverCard(fetchImpl, await tokens.getAccessToken(cred.bot.clientId, cred.secret), {
        chatType: context.chatType,
        senderUserid: sender,
        conversationId: context.conversationId,
        templateId,
        cardParamMap: queueCardParams({ status: 'queued', preview: context.text, queueId, senderUserid: sender }),
        robotCode: cred.bot.robotCode,
      });
    },
    downloadMedia: async (context, workspace) => downloadInbound(context, workspace),
    listenerFactory: async (sessionId, _context, executionId) => {
      const session = await deps.sessionService.getSession(sessionId);
      const model = session.modelId != null ? await deps.modelService.getModel(session.modelId).catch(() => null) : null;
      return new WsStreamingEventListener({
        registry: deps.wsRegistry as never,
        activityService: deps.activityService as never,
        activityHeartbeat: deps.activityHeartbeat as never,
        sessionTodoMapper: deps.todoMapper as never,
        sessionService: deps.sessionService as never,
      }, sessionId, session.userId, executionId, model?.supportsVision === 1);
    },
    onExecutionFinished: async (sessionId, _context, executionId, phase, failureReason) => {
      const session = await deps.sessionService.getSession(sessionId);
      await deps.taskTerminal.finishExecution(sessionId, session.userId, phase, executionId, failureReason);
    },
    afterDelivery: async (sessionId, phase) => {
      if (phase === 'FAILED') return;
      await progressRepo.deleteBySessionId(sessionId).catch((error) => console.warn(`清理钉钉进度卡映射失败, sessionId=${sessionId}`, error));
    },
    onReply: (context, text) => sendText(Number(context.accountId), context, text),
    resolveReplyContext: async (sessionId) => {
      const row = await progressRepo.findBySessionId(sessionId);
      if (row == null) return null;
      return {
        accountId: String(row.botId),
        chatType: row.chatType === 'group' ? 'group' : 'p2p',
        conversationId: row.conversationId ?? '',
        messageId: `retry-${sessionId}`,
        senderUserid: row.senderUserid,
        senderUnionId: null,
        senderName: '',
        msgtype: 'text',
        text: '',
        downloadCodes: [],
        fileName: null,
        quotedText: null,
        isInAtList: true,
      };
    },
    noteReplyFailure: async (sessionId, reason) => {
      const row = await progressRepo.findBySessionId(sessionId);
      if (row == null) return;
      const cred = await credentialsOf(row.botId);
      if (cred == null || templateOf(cred.bot, 'progress') == null) return;
      const params = progressCardParams({
        status: 'failed', round: 0, detail: `回复发送失败：${reason}`, sessionUrl: await sessionDetailUrl(sessionId),
        sessionId, senderUserid: row.senderUserid ?? '',
      });
      await updateCard(fetchImpl, await tokens.getAccessToken(cred.bot.clientId, cred.secret), row.outTrackId, params);
    },
  });

  handlerBox.current = handler;

  /** 钉钉 OAuth 配置实时读取（V191）：后台保存后即时生效，无需重启。 */
  const oauthConfig = (): Promise<DingtalkOauthConfig> => deps.settingService.getDingtalkOauthConfig();

  const processor = new DingtalkInboundProcessor(handler, {
    messageService,
    mergeWindowMs: deps.config.mergeWindowMs,
    oauthConfigured: async () => oauthConfigured(await oauthConfig()),
    resolveUserId: ( _accountId, event) => binding.findUserId(event.senderUserid, event.senderUnionId),
    rememberMember: async (accountId, event, userId) => {
      if (event.senderUserid == null) return;
      await messageService.addMember(accountId, event.conversationId, userId, event.senderUserid, event.senderName);
    },
    sendReply: (accountId, event, text) => sendText(Number(accountId), event, text),
    sendBindingCard: async (accountId, event) => {
      const oauth = await oauthConfig();
      if (!oauthConfigured(oauth)) return false;
      const origin = webOriginOf(oauth.redirectUri);
      if (origin == null) return false;
      const state = await oauthStates.create(null, 3 * 60 * 1000);
      await pending.insert({ state, botId: Number(accountId), event }, new Date(Date.now() + 3 * 60 * 1000));
      try {
        const cred = await credentialsOf(Number(accountId));
        if (cred == null) throw new Error('钉钉机器人不可用');
        const card = bindingCardParam(`${origin}/api/v1/dingtalk/bind/${state}`);
        const target: OutboundTarget = event.chatType === 'group'
          ? { chatType: 'group', robotCode: cred.bot.robotCode, conversationId: event.conversationId }
          : { chatType: 'p2p', robotCode: cred.bot.robotCode, userId: event.senderUserid ?? '' };
        const result = await sendDingtalkMessage({
          token: () => tokens.getAccessToken(cred.bot.clientId, cred.secret),
          fetchImpl,
        }, target, card);
        if (!result.ok) throw new Error(result.reason);
        await pending.markSent(state);
        return true;
      } catch (error) {
        await pending.fail(state);
        console.error(`钉钉绑定卡片发送失败, bot=${accountId}`, error);
        return false;
      }
    },
  });

  const cardActions = new DingtalkCardActionService({
    queuePort: queue,
    findProgress: (outTrackId) => progressRepo.findByOutTrackId(outTrackId),
    interruptAndDrain: (sessionId) => handler.interruptAndDrain(sessionId),
    cancelRunning: async (sessionId) => {
      handler.cancel(sessionId);
      return persistDingtalkCancelIfIdle({
        sessionId,
        hadLoop: deps.agentLoop.getCancelFlag(sessionId) != null,
        persistCancelledIfActive,
        drainNextIfPending: (id) => handler.drainNextIfPending(id),
      });
    },
    getPhase: async (sessionId) => (await deps.sessionService.getSession(sessionId).catch(() => null))?.phase ?? null,
    retryFailed: (sessionId) => handler.retryExecution(sessionId, async () => {
      const row = await progressRepo.findBySessionId(sessionId);
      if (row == null) return null;
      const cred = await credentialsOf(row.botId);
      if (cred == null) return null;
      const session = await deps.sessionService.getSession(sessionId).catch(() => null);
      const startedAt = parseSqlTimeMs(session?.startedAt) ?? Date.now();
      return cardProgress(cred, row.outTrackId, sessionId, row.senderUserid ?? '', startedAt);
    }),
    sessionDetailUrl,
  });

  let streamCtor: StreamCtor | null = null;
  const monitor = new DingtalkMonitorService(deps.config, bots, (clientId, clientSecret) => {
    if (streamCtor == null) throw new Error('dingtalk-stream 未加载');
    return new streamCtor({ clientId, clientSecret, keepAlive: true });
  }, processor, async (raw) => cardActions.decide(raw));

  const mediaSend: DingtalkMediaSendSupport = {
    resolveSendTarget: (sessionId) => resolveSendTarget(sessionId),
    sendImage: async (target, bytes, fileName) => {
      const mediaId = await uploadMedia(fetchImpl, await tokens.getLegacyToken(target.clientId, target.clientSecret), 'image', fileName, bytes);
      const sent = await sendDingtalkMessage({ token: () => tokens.getAccessToken(target.clientId, target.clientSecret), fetchImpl }, target, imageMessageParam(mediaId));
      if (!sent.ok) throw new Error(sent.reason);
      return fileName;
    },
    sendFile: async (target, fileName, bytes) => {
      const shaped = fileMessageParam('placeholder', fileName);
      if ('error' in shaped) throw new Error(shaped.error);
      const mediaId = await uploadMedia(fetchImpl, await tokens.getLegacyToken(target.clientId, target.clientSecret), 'file', fileName, bytes);
      const message = fileMessageParam(mediaId, fileName);
      if ('error' in message) throw new Error(message.error);
      const sent = await sendDingtalkMessage({ token: () => tokens.getAccessToken(target.clientId, target.clientSecret), fetchImpl }, target, message);
      if (!sent.ok) throw new Error(sent.reason);
      return fileName;
    },
  };

  async function pushScheduledResult(sessionId: number, text: string): Promise<void> {
    const session = await deps.sessionService.getSession(sessionId).catch(() => null);
    if (session == null || !isDingtalkChannelSession(session.projectKey, session.workspace)) return;
    const target = await resolveSendTarget(sessionId);
    if (target == null) {
      console.warn(`定时任务钉钉回复跳过：无法解析发送目标, sessionId=${sessionId}`);
      return;
    }
    const privateKey = session.projectKey?.match(/^dingtalk-(\d+)-private-(\d+)$/);
    const parsed = parseWorkspace(session.workspace);
    const botId = privateKey != null ? Number(privateKey[1]) : Number(parsed?.botId);
    const cred = Number.isFinite(botId) ? await credentialsOf(botId) : null;
    if (cred == null) {
      console.warn(`定时任务钉钉回复跳过：机器人不可用, sessionId=${sessionId}`);
      return;
    }
    await deliverScheduledDingtalkReply({
      fetchImpl,
      token: () => tokens.getAccessToken(cred.bot.clientId, cred.secret),
      target,
      text,
      sessionId,
      templateId: templateOf(cred.bot, 'progress'),
      sessionUrl: await sessionDetailUrl(sessionId),
      senderUserid: target.userId ?? '',
      replyMaxLength: deps.config.replyMaxLength,
    });
    if (target.chatType === 'group' && target.conversationId != null) {
      await messageService.recordGroupOutbound(botId, target.conversationId, text).catch((error) => {
        console.warn(`钉钉群出站摘要写入失败, botId=${botId}`, error);
      });
    }
  }

  return {
    mediaSend,
    pushScheduledResult,
    registerRoutes(app) {
      registerDingtalkBotRoutes(app, {
        repository: bots,
        secretKey: deps.config.appSecretKey,
        permissionService: deps.permissionService,
        monitorStatus: monitor,
        monitorReconnect: monitor,
      });
      registerDingtalkBindingRoutes(app, {
        jwt: deps.jwt,
        repository: binding,
        oauthStates,
        oauth: oauthConfig,
        onCallback: async (state, userId, code) => {
          const oauth = await oauthConfig();
          const userToken = await exchangeUserAccessToken(fetchImpl, oauth, code);
          const unionId = await fetchUnionId(fetchImpl, userToken);
          const legacy = await tokens.getLegacyToken(oauth.clientId, oauth.clientSecret);
          const userid = await fetchUseridByUnionId(fetchImpl, legacy, unionId);
          await binding.bind(userId, unionId, userid);
          const replay = await pending.claim(state);
          if (replay == null) return;
          try {
            // 绑定后补投绕开合并窗口：用户等的是这条消息的即时响应，不能被窗口期拖延。
            await processor.process(String(replay.botId), replay.event, true, { bypassWindow: true });
            await pending.complete(state);
          } catch (error) {
            await pending.release(state);
            throw error;
          }
        },
      });
    },
    start() {
      if (!deps.config.enabled) return;
      void import('dingtalk-stream').then((mod) => {
        streamCtor = (mod as { DWClient: StreamCtor }).DWClient;
        monitor.start();
      }).catch((error) => console.error('加载 dingtalk-stream 失败', error));
    },
    shutdown() { monitor.shutdown(); },
    async flushInbound() { await processor.flushAll(); },
    recoverProgress: async (sessionId) => {
      const row = await progressRepo.findBySessionId(sessionId);
      if (row == null) return null;
      const cred = await credentialsOf(row.botId);
      if (cred == null || templateOf(cred.bot, 'progress') == null) return null;
      const session = await deps.sessionService.getSession(sessionId).catch(() => null);
      const startedAt = parseSqlTimeMs(session?.startedAt) ?? Date.now();
      const progress = cardProgress(cred, row.outTrackId, sessionId, row.senderUserid ?? '', startedAt);
      const roundOffset = await countCompletedAgentRounds(await deps.sessionService.getMessages(sessionId).catch(() => undefined));
      try { await progress.update('RUNNING', roundOffset, '任务正在恢复执行。', []); } catch (error) {
        console.warn(`钉钉恢复进度卡更新失败, sessionId=${sessionId}`, error);
      }
      return { progress, roundOffset };
    },
    onCrashFinished: async (sessionId, phase) => {
      if (phase === 'FAILED') return;
      await progressRepo.deleteBySessionId(sessionId).catch(() => undefined);
      await handler.drainNextIfPending(sessionId);
    },
    hydrate: async () => {
      const sessionIds = await queue.hydrate();
      for (const sessionId of sessionIds) await handler.drainNextIfPending(sessionId);
    },
    /** WS 侧 message_queue 排空接力：消费钉钉入站队列（busy 入队消息）。 */
    drainNextIfPending: (sessionId: number) => handler.drainNextIfPending(sessionId),
    /** 供 WS autoConsume 的跨通道忙检查（同步、无副作用）。 */
    hasRunningSession: (sessionId: number) => handler.hasRunningSession(sessionId),
  };

  async function applyBotConfig(sessionId: number, botId: number): Promise<void> {
    const bot = await bots.findById(botId);
    if (bot == null) return;
    const session = await deps.sessionService.getSession(sessionId);
    const agent = bot.agentId != null ? await deps.agentService.getAgent(bot.agentId) : await deps.agentService.requireDefaultAgent();
    const model = bot.modelId != null ? await deps.modelService.getModel(bot.modelId) : await deps.modelService.getDefaultModel();
    const fields: Record<string, unknown> = {};
    if (agent?.id != null && session.agentId !== agent.id) fields.agentId = agent.id;
    if (session.modelId !== (model?.id ?? null)) fields.modelId = model?.id ?? null;
    if (Object.keys(fields).length > 0) await deps.sessionRepo.updateFields(sessionId, fields);
  }

  async function persistCancelledIfActive(sessionId: number): Promise<boolean> {
    const session = await deps.sessionService.getSession(sessionId).catch(() => null);
    if (session == null) return false;
    if (session.phase !== 'RUNNING' && session.phase !== 'RESUMING') return false;
    await deps.sessionService.cleanupIncompleteTail(sessionId);
    await deps.taskTerminal.finishExecution(sessionId, session.userId, 'CANCELLED', `dingtalk-cancel-${sessionId}`);
    await progressRepo.deleteBySessionId(sessionId).catch(() => undefined);
    return true;
  }

  async function resolveSendTarget(sessionId: number | null): Promise<DingtalkSendTarget | null> {
    if (sessionId == null) return null;
    const session = await deps.sessionService.getSession(sessionId).catch(() => null);
    if (session == null || !isDingtalkChannelSession(session.projectKey, session.workspace)) return null;
    const parsed = parseWorkspace(session.workspace);
    const privateKey = session.projectKey?.match(/^dingtalk-(\d+)-private-(\d+)$/);
    const botId = privateKey != null ? Number(privateKey[1]) : Number(parsed?.botId);
    if (!Number.isFinite(botId)) return null;
    const cred = await credentialsOf(botId);
    if (cred == null) return null;
    if (privateKey != null || parsed?.leaf.startsWith('p2p-')) {
      const userId = privateKey != null ? Number(privateKey[2]) : Number(parsed?.leaf.slice(4));
      const status = await binding.getStatus(userId);
      if (!status.bound || status.userid == null) return null;
      return { chatType: 'p2p', robotCode: cred.bot.robotCode, userId: status.userid, clientId: cred.bot.clientId, clientSecret: cred.secret };
    }
    if (parsed == null) return null;
    return { chatType: 'group', robotCode: cred.bot.robotCode, conversationId: parsed.leaf, clientId: cred.bot.clientId, clientSecret: cred.secret };
  }

  async function downloadInbound(context: DingtalkInboundContext, workspace: string | null): Promise<{ images: string[]; imagePaths: string[]; filePaths: string[]; errors: string[] } | null> {
    if (context.downloadCodes.length === 0) return null;
    const cred = await credentialsOf(Number(context.accountId));
    if (cred == null) return { images: [], imagePaths: [], filePaths: [], errors: ['文件'] };
    const images: string[] = [];
    const imagePaths: string[] = [];
    const filePaths: string[] = [];
    const errors: string[] = [];
    const isFile = context.msgtype === 'file';
    for (let index = 0; index < context.downloadCodes.length; index++) {
      const label = context.fileName || (isFile ? '文件' : '图片');
      try {
        const url = await exchangeDownloadUrl(fetchImpl, await tokens.getAccessToken(cred.bot.clientId, cred.secret), cred.bot.robotCode, context.downloadCodes[index]);
        const downloaded = await downloadBytes(fetchImpl, url, 20 * 1024 * 1024);
        if (isFile) {
          if (workspace == null) throw new Error('没有工作区');
          const dir = chatFilesDirOf(workspace);
          mkdirSync(dir, { recursive: true });
          const name = sanitizeName(context.fileName, `dingtalk-file-${context.messageId}`);
          // 同日同名文件防覆盖：命中时改用带 messageId 的唯一名，历史引用不被篡改
          const target = resolveChatFileTarget(dir, name, context.messageId, index);
          await writeFile(target, downloaded.buffer);
          filePaths.push(target);
        } else {
          const mime = downloaded.contentType.startsWith('image/') ? downloaded.contentType : 'image/jpeg';
          images.push(`data:${mime};base64,${downloaded.buffer.toString('base64')}`);
          if (workspace != null) {
            const dir = chatFilesDirOf(workspace);
            mkdirSync(dir, { recursive: true });
            const ext = mime === 'image/png' ? '.png' : mime === 'image/gif' ? '.gif' : '.jpg';
            const name = index === 0 ? `dingtalk-image-${context.messageId}${ext}` : `dingtalk-image-${context.messageId}-${index + 1}${ext}`;
            const target = resolve(dir, name);
            await writeFile(target, downloaded.buffer);
            imagePaths.push(target);
          }
        }
      } catch (error) {
        console.warn(`钉钉文件下载失败, messageId=${context.messageId}`, error);
        errors.push(label);
      }
    }
    return { images, imagePaths, filePaths, errors };
  }
}

function parseWorkspace(workspace: string | null | undefined): { botId: string; leaf: string } | null {
  if (workspace == null) return null;
  const parts = workspace.replace(/\\/g, '/').split('/');
  const index = parts.lastIndexOf('dingtalk-chat');
  if (index < 0 || index + 2 >= parts.length) return null;
  try {
    return { botId: decodeURIComponent(parts[index + 1]), leaf: decodeURIComponent(parts[index + 2]) };
  } catch {
    return null;
  }
}

function sanitizeName(name: string | null, fallback: string): string {
  const base = (name ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = base.replace(/[^\w.\u4e00-\u9fa5-]/g, '_').replace(/^_+|_+$/g, '');
  return cleaned === '' ? fallback : cleaned.slice(0, 128);
}

function parseSqlTimeMs(value: string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const parsed = Date.parse(value.includes('T') ? value : value.replace(' ', 'T'));
  return Number.isFinite(parsed) ? parsed : null;
}
