import * as Lark from '@larksuiteoapi/node-sdk';
import { createFeishuPatchedProgress, type FeishuProgressHandle } from './feishu/patched-progress.js';
import type { FeishuCardProgress } from './feishu/card-progress-listener.js';
import { buildFeishuProgressCard } from './feishu/progress-card.js';
import type { FeishuInboundContext, FeishuNormalizedMessage } from './feishu/types.js';
import type { FeishuMessageService } from './feishu/message.service.js';
import type { FeishuActiveProgressRegistry } from './feishu/active-progress.js';
import type { FeishuAskFormStore } from './feishu/ask-form-store.js';
import type { MysqlFeishuProgressCardRepository } from './feishu/progress-card.repository.js';
import type { MysqlFeishuCardSnapshotRepository } from './feishu/card-snapshot.repository.js';
import type { MysqlFeishuPendingBindingRepository } from './feishu/pending-binding.repository.js';
import type { BackgroundSubagentManager } from './harness/delegate/background-subagent-manager.js';
import type { FeedbackDbLookup } from './feedback/feedback.service.js';
import type { SessionService } from './session/session.service.js';
import type { EcpAuthService } from './auth/ecp-auth.service.js';
import type { FeishuAuthService } from './auth/feishu-auth.service.js';
import {
  buildFeishuAuthGuideCard,
  feishuUnauthorizedGuide,
  feishuUnauthorizedFallbackText,
  persistFeishuPendingAuth,
  startFeishuChannelAuthLink,
} from './feishu/ecp-inbound-gate.js';
import { parseSqlTimeMs } from './app-utils.js';

// ========== 排队卡片 ==========

export function buildFeishuQueueCard(context: FeishuInboundContext, queueId: number, position: number): Record<string, unknown> {
  const summary = context.text.length > 60 ? `${context.text.slice(0, 60)}…` : context.text;
  const showSender = context.chatType === 'group';
  const senderLabel = (context.senderLabel?.trim() || '用户');
  const body = showSender ? `${senderLabel}：${summary}` : summary;
  return {
    schema: '2.0',
    config: { update_multi: true },
    body: {
      direction: 'vertical', padding: '12px 12px 12px 12px',
      elements: [
        { tag: 'markdown', content: '**⏳ 任务排队中**', text_align: 'left', text_size: 'normal_v2' },
        { tag: 'markdown', content: `当前任务正在执行中，这条消息已进入队列（第 ${position} 位），将在当前任务完成后自动开始处理。`, text_align: 'left', text_size: 'normal_v2' },
        { tag: 'markdown', content: body, text_align: 'left', text_size: 'normal_v2' },
        {
          tag: 'column_set', flex_mode: 'flow', background_style: 'default',
          columns: [
            { tag: 'column', width: 'auto', vertical_align: 'top', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '立即发送' }, type: 'primary', size: 'sm', value: { kind: 'feishu_queue', queueId, act: 'run' } }] },
            { tag: 'column', width: 'auto', vertical_align: 'top', elements: [{ tag: 'button', text: { tag: 'plain_text', content: '取消排队' }, type: 'default', size: 'sm', value: { kind: 'feishu_queue', queueId, act: 'cancel' } }] },
          ],
        },
      ],
    },
  };
}

export interface FeishuQueueCardDeps {
  getFeishuClient: (botId: number) => Promise<Lark.Client | null>;
  feishuMessageService: FeishuMessageService;
}

export function createFeishuQueueCardHelper(deps: FeishuQueueCardDeps) {
  const { getFeishuClient, feishuMessageService } = deps;

  return async (context: FeishuInboundContext, queueId: number, position: number, sessionId: number): Promise<string | null> => {
    const client = await getFeishuClient(Number(context.accountId));
    if (client == null) return null;
    const data = { msg_type: 'interactive', content: JSON.stringify(buildFeishuQueueCard(context, queueId, position)) };
    const response = await (context.chatType === 'group' && context.messageId != null
      ? client.im.v1.message.reply({ path: { message_id: context.messageId }, data })
      : client.im.v1.message.create({ params: { receive_id_type: 'open_id' }, data: { ...data, receive_id: context.senderId! } }));
    const cardMessageId = (response as { data?: { message_id?: string } }).data?.message_id ?? null;
    if (cardMessageId != null && context.chatType === 'p2p') {
      await feishuMessageService.recordP2pMessage(context.accountId, cardMessageId, sessionId, 'OUT');
    }
    return cardMessageId;
  };
}

// ========== 进度卡片 PATCH ==========

export interface PatchedProgressDeps {
  feishuActiveProgress: FeishuActiveProgressRegistry;
  feishuAskFormStore: FeishuAskFormStore;
  feishuCardSnapshotRepo: MysqlFeishuCardSnapshotRepository;
  backgroundSubagentManager: BackgroundSubagentManager;
  feedbackMessageLookup: FeedbackDbLookup;
}

export function createPatchedProgressHelper(deps: PatchedProgressDeps) {
  const { feishuActiveProgress, feishuAskFormStore, feishuCardSnapshotRepo, backgroundSubagentManager, feedbackMessageLookup } = deps;

  return (
    client: Lark.Client,
    cardMessageId: string,
    sessionId: number,
    cancelAction: { sessionId: number; sender: string; botId?: number } | null,
    startedAtMs: number,
    sessionDetailUrl?: string,
    seed?: { round?: number; content?: string },
    botId?: number,
  ): FeishuCardProgress => {
    const gate: { progress: FeishuProgressHandle | null } = { progress: null };
    const progress = createFeishuPatchedProgress({
      listAsks: () => (
        gate.progress != null && feishuActiveProgress.current(sessionId) === gate.progress
          ? feishuAskFormStore.list(sessionId)
          : []
      ),
      clearAsks: () => {
        if (gate.progress != null && feishuActiveProgress.current(sessionId) === gate.progress) {
          feishuAskFormStore.clearSession(sessionId);
        }
      },
      patch: async (card) => {
        await client.im.v1.message.patch({ path: { message_id: cardMessageId }, data: { content: JSON.stringify(card) } });
      },
      buildCard: ({ status, round, content, tools, subagents, pendingAsks, elapsedMs, disliked }) => buildFeishuProgressCard(
        status, round, content, tools, cancelAction ?? undefined, elapsedMs, sessionDetailUrl, pendingAsks, disliked, subagents,
      ),
      loadSubagents: async () => {
        const running = await backgroundSubagentManager.listRunning(sessionId);
        return running.map((subagent) => ({
          taskId: subagent.taskId,
          agentType: subagent.agentType,
          title: subagent.title,
          status: subagent.status,
          round: subagent.round,
        }));
      },
      persistTerminal: botId == null ? undefined : async ({ round, content, elapsedMs, messageId }) => {
        const terminalMessageId = messageId ?? await feedbackMessageLookup.findLatestAssistantMessageId(sessionId);
        if (terminalMessageId == null) {
          console.warn(`飞书完成卡快照跳过: 终态时未找到ASSISTANT消息, sessionId=${sessionId}, cardMessageId=${cardMessageId}`);
          return;
        }
        await feishuCardSnapshotRepo.upsert({
          cardMessageId, sessionId, botId, messageId: terminalMessageId,
          status: 'COMPLETED', round, elapsedMs: elapsedMs ?? 0, content,
        });
      },
      startedAtMs,
      seed: { status: 'RUNNING', round: seed?.round ?? 0, content: seed?.content ?? '', tools: [] },
    });
    gate.progress = progress;
    feishuActiveProgress.bind(sessionId, cancelAction?.sender ?? '', progress, cardMessageId);
    return progress;
  };
}

// ========== 进度卡片创建 ==========

export interface FeishuProgressCardDeps {
  getFeishuClient: (botId: number) => Promise<Lark.Client | null>;
  feishuMessageService: FeishuMessageService;
  feishuProgressCardRepo: MysqlFeishuProgressCardRepository;
  resolveFeishuSessionDetailUrl: (sessionId: number) => Promise<string | undefined>;
  createPatchedProgress: (
    client: Lark.Client,
    cardMessageId: string,
    sessionId: number,
    cancelAction: { sessionId: number; sender: string; botId?: number } | null,
    startedAtMs: number,
    sessionDetailUrl?: string,
    seed?: { round?: number; content?: string },
    botId?: number,
  ) => FeishuCardProgress;
}

export function createFeishuProgressCardHelper(deps: FeishuProgressCardDeps) {
  const { getFeishuClient, feishuMessageService, feishuProgressCardRepo, resolveFeishuSessionDetailUrl, createPatchedProgress } = deps;

  return async (context: FeishuInboundContext, sessionId: number): Promise<FeishuCardProgress | null> => {
    const botId = Number(context.accountId);
    const client = await getFeishuClient(botId);
    if (client == null) return null;
    const cancelAction = { sessionId, sender: context.senderId ?? '', botId };
    const sessionDetailUrl = await resolveFeishuSessionDetailUrl(sessionId);
    const persistCard = async (cardMessageId: string): Promise<void> => {
      try {
        await feishuProgressCardRepo.upsert({
          sessionId, botId, cardMessageId,
          chatType: context.chatType,
          chatId: context.chatId,
          senderOpenId: context.senderId,
        });
      } catch (error) {
        console.warn(`飞书进度卡片映射持久化失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    const existingMessageId = context.progressCardMessageId;
    const startedAtMs = Date.now();
    if (existingMessageId != null) {
      const card = buildFeishuProgressCard('RUNNING', 0, '任务已接收，正在准备执行。', [], cancelAction, undefined, sessionDetailUrl);
      await client.im.v1.message.patch({ path: { message_id: existingMessageId }, data: { content: JSON.stringify(card) } });
      await persistCard(existingMessageId);
      return createPatchedProgress(client, existingMessageId, sessionId, cancelAction, startedAtMs, sessionDetailUrl, {
        content: '任务已接收，正在准备执行。',
      }, botId);
    }
    const card = buildFeishuProgressCard('RUNNING', 0, '任务已接收，正在准备执行。', [], cancelAction, undefined, sessionDetailUrl);
    const data = { msg_type: 'interactive', content: JSON.stringify(card) };
    const response = await (context.chatType === 'group' && context.messageId != null
      ? client.im.v1.message.reply({ path: { message_id: context.messageId }, data })
      : client.im.v1.message.create({
        params: { receive_id_type: context.chatType === 'group' ? 'chat_id' : 'open_id' },
        data: { ...data, receive_id: context.chatType === 'group' ? context.chatId! : context.senderId! },
      }));
    const messageId = (response as { data?: { message_id?: string } }).data?.message_id;
    if (messageId == null || messageId === '') throw new Error('飞书处理中卡片发送失败：未返回 message_id');
    await persistCard(messageId);
    if (context.chatType === 'p2p') await feishuMessageService.recordP2pMessage(String(botId), messageId, sessionId, 'OUT');
    return createPatchedProgress(client, messageId, sessionId, cancelAction, startedAtMs, sessionDetailUrl, {
      content: '任务已接收，正在准备执行。',
    }, botId);
  };
}

// ========== 恢复进度卡片 ==========

export interface FeishuRecoveryProgressDeps {
  getFeishuClient: (botId: number) => Promise<Lark.Client | null>;
  feishuProgressCardRepo: MysqlFeishuProgressCardRepository;
  sessionService: SessionService;
  resolveFeishuSessionDetailUrl: (sessionId: number) => Promise<string | undefined>;
  resolveFeishuRoundOffset: (sessionId: number) => Promise<number>;
  createPatchedProgress: (
    client: Lark.Client,
    cardMessageId: string,
    sessionId: number,
    cancelAction: { sessionId: number; sender: string; botId?: number } | null,
    startedAtMs: number,
    sessionDetailUrl?: string,
    seed?: { round?: number; content?: string },
    botId?: number,
  ) => FeishuCardProgress;
}

export function createFeishuRecoveryProgressHelper(deps: FeishuRecoveryProgressDeps) {
  const { getFeishuClient, feishuProgressCardRepo, sessionService, resolveFeishuSessionDetailUrl, resolveFeishuRoundOffset, createPatchedProgress } = deps;

  return async (sessionId: number): Promise<{ progress: FeishuCardProgress; roundOffset: number } | null> => {
    try {
      const row = await feishuProgressCardRepo.findBySessionId(sessionId);
      if (row == null) {
        console.warn(`飞书恢复进度卡片无映射, sessionId=${sessionId}`);
        return null;
      }
      const client = await getFeishuClient(row.botId);
      if (client == null) {
        console.warn(`飞书恢复进度卡片无法创建客户端, sessionId=${sessionId} botId=${row.botId}`);
        return null;
      }
      const cancelAction = row.senderOpenId != null && row.senderOpenId !== ''
        ? { sessionId, sender: row.senderOpenId, botId: row.botId }
        : null;
      const sessionDetailUrl = await resolveFeishuSessionDetailUrl(sessionId);
      const session = await sessionService.getSession(sessionId).catch(() => null);
      const startedAtMs = parseSqlTimeMs(session?.startedAt) ?? Date.now();
      const progress = createPatchedProgress(client, row.cardMessageId, sessionId, cancelAction, startedAtMs, sessionDetailUrl, {
        content: '任务正在恢复执行。',
      }, row.botId);
      const roundOffset = await resolveFeishuRoundOffset(sessionId);
      try {
        await progress.update('RUNNING', roundOffset, '任务正在恢复执行。', []);
      } catch (error) {
        console.warn(`飞书恢复进度卡片首次 PATCH 失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return { progress, roundOffset };
    } catch (error) {
      console.warn(`飞书恢复进度卡片加载失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };
}

// ========== 未授权卡片 ==========

export interface SendUnauthorizedCardDeps {
  getFeishuClient: (botId: number) => Promise<Lark.Client | null>;
  ecpAuth: EcpAuthService;
  feishu: FeishuAuthService;
  pendingBindingMessages: MysqlFeishuPendingBindingRepository;
}

export function createSendUnauthorizedCardHelper(deps: SendUnauthorizedCardDeps) {
  const { getFeishuClient, ecpAuth, feishu, pendingBindingMessages } = deps;

  return async (accountId: string, event: FeishuNormalizedMessage): Promise<boolean> => {
    const client = await getFeishuClient(Number(accountId));
    if (client == null || event.messageId == null) return false;
    if (event.chatType === 'group' && event.chatId == null) return false;
    if (event.chatType === 'p2p' && event.senderId == null) return false;
    let auth: { authUrl: string; state: string } | null = null;
    try {
      auth = await startFeishuChannelAuthLink({
        ecpEnabled: await ecpAuth.isEnabled(),
        feishuEnabled: await feishu.isEnabled(),
        startEcp: () => ecpAuth.startFeishuLogin('desktop'),
        startFeishu: () => feishu.getQrCodeUrl(),
      });
    } catch (error) {
      console.error('飞书未授权引导获取登录链接失败', error);
      return false;
    }
    if (auth == null || auth.authUrl.trim() === '') return false;
    const inboundMessageId = event.messageId;
    const persisted = await persistFeishuPendingAuth(
      () => pendingBindingMessages.insert({ state: auth.state, appId: Number(accountId), messageId: inboundMessageId, event }),
      auth.state,
    );
    const ecpEnabled = await ecpAuth.isEnabled();
    const guide = feishuUnauthorizedGuide(ecpEnabled, event.chatType);
    const card = buildFeishuAuthGuideCard(guide, auth.authUrl);
    const data = { msg_type: 'interactive' as const, content: JSON.stringify(card) };
    let response;
    try {
      response = await (event.chatType === 'group'
        ? client.im.v1.message.reply({ path: { message_id: inboundMessageId }, data })
        : client.im.v1.message.create({
            params: { receive_id_type: 'open_id' },
            data: { ...data, receive_id: event.senderId! },
          }));
    } catch (error) {
      if (persisted) await pendingBindingMessages.fail(auth.state);
      throw error;
    }
    const cardMessageId = (response as { data?: { message_id?: string } }).data?.message_id;
    if (cardMessageId == null || cardMessageId === '') {
      if (persisted) await pendingBindingMessages.fail(auth.state);
      return false;
    }
    if (persisted) {
      try {
        await pendingBindingMessages.setCardMessageId(auth.state, cardMessageId);
      } catch (error) {
        console.error(`飞书登录引导卡片已发送但回写 card_message_id 失败, state=${auth.state}`, error);
      }
    }
    return true;
  };
}

// ========== 未授权文本 ==========

export interface UnauthorizedTextDeps {
  ecpAuth: EcpAuthService;
}

export function createUnauthorizedTextHelper(deps: UnauthorizedTextDeps) {
  const { ecpAuth } = deps;

  return async (_accountId: string, event: FeishuNormalizedMessage): Promise<string> => {
    const ecpEnabled = await ecpAuth.isEnabled();
    return feishuUnauthorizedFallbackText(feishuUnauthorizedGuide(ecpEnabled, event.chatType));
  };
}
