import * as Lark from '@larksuiteoapi/node-sdk';
import type { MysqlFeishuBotRepository } from './feishu/feishu_bot.repository.js';
import type { SessionService } from './session/session.service.js';
import type { SessionRepository } from './session/session.repository.js';
import type { AgentService } from './agent/agent.service.js';
import type { ModelService } from './model/model.service.js';
import type { FeishuInboundContext, FeishuNormalizedMessage } from './feishu/types.js';
import type { FeishuMessageService } from './feishu/message.service.js';
import type { MysqlFeishuBindingRepository } from './feishu/binding.repository.js';
import type { MysqlFeishuMessageRepository } from './feishu/message.repository.js';
import type { EcpAuthService } from './auth/ecp-auth.service.js';
import type { MysqlEcpSessionRepository } from './auth/ecp-session.repository.js';
import type { SystemSettingService } from './settings/settings.service.js';
import { createSessionDetailUrlResolver } from './feishu/progress-card.js';
import { senderName } from './feishu/message.service.js';
import { hasUsableEcpSession } from './auth/ecp-session.repository.js';
import { senderUnionIdOf } from './feishu/ecp-inbound-gate.js';
import { buildQuotedInjection } from './feishu/quoted-injection.js';
import { resolveFeishuQuotedText } from './feishu/merge-forward.js';
import { fetchFeishuMessageDetail } from './feishu/message-detail.js';
import { formatGroupTime } from './feishu/message.service.js';

// ========== 会话配置 ==========

export interface FeishuSessionDeps {
  feishuBots: MysqlFeishuBotRepository;
  sessionService: SessionService;
  sessionRepo: SessionRepository;
  agentService: AgentService;
  modelService: ModelService;
  getFeishuChatTitle: (botId: number, chatId: string) => Promise<string>;
}

export interface FeishuSessionHelper {
  applyFeishuBotConfig(sessionId: number, botId: number): Promise<void>;
  ensureFeishuSessionTitle(sessionId: number, accountId: number, context: FeishuInboundContext): Promise<void>;
}

export function createFeishuSessionHelper(deps: FeishuSessionDeps): FeishuSessionHelper {
  const { feishuBots, sessionService, sessionRepo, agentService, modelService, getFeishuChatTitle } = deps;

  const applyFeishuBotConfig = async (sessionId: number, botId: number): Promise<void> => {
    const bot = await feishuBots.findById(botId);
    if (bot == null) return;
    const session = await sessionService.getSession(sessionId);
    if (session == null || session.id == null) return;
    const agent = bot.agentId != null ? await agentService.getAgent(bot.agentId) : await agentService.requireDefaultAgent();
    const model = bot.modelId != null ? await modelService.getModel(bot.modelId) : await modelService.getDefaultModel();
    const agentId = agent?.id ?? null;
    const modelId = model?.id ?? null;
    const fields: Record<string, unknown> = {};
    if (agentId != null && session.agentId !== agentId) fields.agentId = agentId;
    if (session.modelId !== modelId) fields.modelId = modelId;
    if (Object.keys(fields).length > 0) {
      console.info(`飞书会话热切换 Agent/模型, sessionId=${sessionId}, botId=${botId}`, fields);
      await sessionRepo.updateFields(session.id, fields);
    }
  };

  const ensureFeishuSessionTitle = async (sessionId: number, accountId: number, context: FeishuInboundContext): Promise<void> => {
    try {
      if (context.chatType !== 'group' || context.chatId == null) return;
      const session = await sessionService.getSession(sessionId);
      if (session?.title !== '飞书Bot会话') return;
      const title = await getFeishuChatTitle(accountId, context.chatId);
      if (title === '') return;
      await sessionRepo.updateFields(sessionId, { title });
      console.info(`飞书会话标题更新为群名称, sessionId=${sessionId}, chatId=${context.chatId}, title=${title}`);
    } catch (error) {
      console.warn(`更新飞书会话标题失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return { applyFeishuBotConfig, ensureFeishuSessionTitle };
}

// ========== 会话详情 URL ==========

export interface FeishuSessionUrlDeps {
  settingService: SystemSettingService;
}

export function createFeishuSessionUrlHelper(deps: FeishuSessionUrlDeps) {
  const { settingService } = deps;

  return createSessionDetailUrlResolver({
    getSiteBaseUrl: () => settingService.getSiteBaseUrl(),
  });
}

// ========== 话题会话 ==========

export interface ThreadSessionDeps {
  feishuMessageService: FeishuMessageService;
}

export function createThreadSessionHelper(deps: ThreadSessionDeps) {
  const { feishuMessageService } = deps;

  return {
    resolveThreadSession: async (accountId: string, event: FeishuNormalizedMessage): Promise<{ sessionId: number } | null> => {
      const result = await feishuMessageService.findThreadSession(String(accountId), event.threadId);
      return result == null ? null : { sessionId: result.sessionId };
    },
    ensureThreadSession: async (accountId: string, context: FeishuInboundContext): Promise<{ sessionId: number } | null> => {
      const result = await feishuMessageService.getOrCreateThreadSession(String(accountId), context);
      return result == null ? null : { sessionId: result.sessionId };
    },
  };
}

// ========== 用户 ID 解析 ==========

export interface FeishuUserIdDeps {
  feishuBinding: MysqlFeishuBindingRepository;
}

export function createFeishuUserIdHelper(deps: FeishuUserIdDeps) {
  const { feishuBinding } = deps;

  return async (accountId: string, context: FeishuInboundContext): Promise<number | undefined> => {
    const unionId = context.senderUnionId ?? context.senderId;
    if (unionId == null) return undefined;
    return (await feishuBinding.findUserIdByUnionId(unionId)) ?? undefined;
  };
}

export function createResolveUserIdHelper(deps: FeishuUserIdDeps) {
  const { feishuBinding } = deps;

  return async (_accountId: string, event: FeishuNormalizedMessage): Promise<number | null> => {
    const unionId = senderUnionIdOf(event);
    if (unionId == null) return null;
    return (await feishuBinding.findUserIdByUnionId(unionId)) ?? null;
  };
}

// ========== 发送者授权 ==========

export interface AuthorizeSenderDeps {
  feishuBinding: MysqlFeishuBindingRepository;
  feishuMessageRepository: MysqlFeishuMessageRepository;
  ecpAuth: EcpAuthService;
  ecpSessionRepo: MysqlEcpSessionRepository;
}

export function createAuthorizeSenderHelper(deps: AuthorizeSenderDeps) {
  const { feishuBinding, feishuMessageRepository, ecpAuth, ecpSessionRepo } = deps;

  return async (accountId: string, event: FeishuNormalizedMessage): Promise<boolean> => {
    const unionId = senderUnionIdOf(event);
    if (unionId == null) return false;
    const userId = await feishuBinding.findUserIdByUnionId(unionId);
    if (userId == null) return false;
    if (await ecpAuth.isEnabled() && !(await hasUsableEcpSession(ecpSessionRepo, userId))) return false;
    if (event.chatType === 'group') {
      if (event.chatId == null) return false;
      await feishuMessageRepository.addGroupMember(String(accountId), event.chatId, userId, event.senderId!, senderName(event));
      return true;
    }
    return true;
  };
}

// ========== 引用消息解析 ==========

export interface ResolveQuotedMessageDeps {
  getFeishuClient: (botId: number) => Promise<Lark.Client | null>;
  feishuMessageRepository: MysqlFeishuMessageRepository;
  resolveQuotedWorkspace: (accountId: string, event: FeishuNormalizedMessage) => Promise<string | null>;
  expandMergeForward: (accountId: string, messageId: string, workspace: string | null) => Promise<string | null>;
}

export function createResolveQuotedMessageHelper(deps: ResolveQuotedMessageDeps) {
  const { getFeishuClient, feishuMessageRepository, resolveQuotedWorkspace, expandMergeForward } = deps;

  return async (accountId: string, event: FeishuNormalizedMessage): Promise<string | null> => {
    if (event.parentId == null) return null;
    const persist = async (raw: string): Promise<string> => {
      return buildQuotedInjection(raw, { parentMessageId: event.parentId!, workspace: await resolveQuotedWorkspace(accountId, event) });
    };
    const fromLog = event.chatId != null
      ? await feishuMessageRepository.findGroupMessageByMessageId(String(accountId), event.chatId, event.parentId)
      : null;
    return resolveFeishuQuotedText({
      log: fromLog == null ? null : {
        msgType: fromLog.msgType,
        content: fromLog.content,
        line: `[${formatGroupTime(fromLog.createdAt)}] ${fromLog.senderName}：${fromLog.content ?? ''}`,
      },
      fetchDetail: async () => {
        const client = await getFeishuClient(Number(accountId));
        if (client == null) return null;
        const detail = await fetchFeishuMessageDetail(client, event.parentId!);
        return detail == null ? null : { msgType: detail.msgType, text: detail.text };
      },
      expand: (workspace) => expandMergeForward(accountId, event.parentId!, workspace),
      resolveWorkspace: () => resolveQuotedWorkspace(accountId, event),
      persist,
    });
  };
}
