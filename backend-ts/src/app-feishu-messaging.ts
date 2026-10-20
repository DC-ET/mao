import { mkdirSync } from 'node:fs';
import type { Db } from './db/db.js';
import type { AppConfig } from './config/app-config.js';
import type { MysqlFeishuBotRepository } from './feishu/feishu_bot.repository.js';
import type { MysqlFeishuBindingRepository } from './feishu/binding.repository.js';
import type { MysqlUserRepository } from './user/user.repository.js';
import type { AgentService } from './agent/agent.service.js';
import type { ModelService } from './model/model.service.js';
import type { SessionService } from './session/session.service.js';
import type { LlmChatClient, LlmModelConfig } from './model/types.js';
import type { FeishuInboundContext } from './feishu/types.js';

import { MysqlFeishuMessageRepository } from './feishu/message.repository.js';
import { FeishuMessageService } from './feishu/message.service.js';
import { feishuSummarizerModelConfig, GroupContextSummarizer } from './feishu/group-context-summarizer.js';
import { createFeishuClientHelper } from './feishu-client.js';
import { resolveFeishuChatWorkspace } from './feishu-media.js';

export interface FeishuMessagingDeps {
  db: Db;
  cfg: AppConfig;
  feishuBots: MysqlFeishuBotRepository;
  feishuBinding: MysqlFeishuBindingRepository;
  userRepo: MysqlUserRepository;
  agentService: AgentService;
  modelService: ModelService;
  sessionService: SessionService;
  routeChatClient: (config: LlmModelConfig) => LlmChatClient;
}

export interface FeishuMessagingResult {
  feishuMessageRepository: MysqlFeishuMessageRepository;
  feishuMessageService: FeishuMessageService;
  getFeishuClient: ReturnType<typeof createFeishuClientHelper>['getFeishuClient'];
  getFeishuChatTitle: ReturnType<typeof createFeishuClientHelper>['getFeishuChatTitle'];
  sendFeishuText: ReturnType<typeof createFeishuClientHelper>['sendFeishuText'];
}

/**
 * 飞书消息层：Bot 客户端、会话/群聊映射、消息落库。
 *
 * 该层早于 harness 装配：createDefaultToolRegistry 的飞书工具在执行期通过闭包取用
 * 此处构造的 service/client，因此必须在 assembleHarnessEngine 之前完成装配。
 */
export function assembleFeishuMessaging(deps: FeishuMessagingDeps): FeishuMessagingResult {
  const {
    db, cfg, feishuBots, feishuBinding, userRepo, agentService, modelService, sessionService, routeChatClient,
  } = deps;

  const feishuMessageRepository = new MysqlFeishuMessageRepository(db);
  const { getFeishuClient, getFeishuChatTitle, sendFeishuText } = createFeishuClientHelper({
    feishuBots,
    appSecretKey: cfg.feishu.bot.appSecretKey,
    replyMaxLength: cfg.feishu.bot.reply.maxLength,
  });
  const feishuMessageService = new FeishuMessageService(
    feishuMessageRepository,
    {
      create: async (accountId: string, context: FeishuInboundContext) => {
        const bot = await feishuBots.findById(Number(accountId));
        if (bot == null) throw new Error(`飞书Bot不存在: ${accountId}`);
        const unionId = context.senderUnionId ?? context.senderId;
        const userId = unionId == null ? null : await feishuBinding.findUserIdByUnionId(unionId);
        const user = userId == null ? null : await userRepo.findById(userId);
        if (user?.id == null) throw new Error(`飞书用户未绑定: ${context.senderId ?? ''}`);
        const agent = bot.agentId != null ? await agentService.getAgent(bot.agentId) : await agentService.requireDefaultAgent();
        const model = bot.modelId != null ? await modelService.getModel(bot.modelId) : await modelService.getDefaultModel();
        const workspaceLeaf = context.chatType === 'group' && context.chatId != null ? context.chatId! : `private-${user.id}`;
        const workspace = resolveFeishuChatWorkspace(cfg.app.harness.workspaceRoot, accountId, workspaceLeaf);
        mkdirSync(workspace, { recursive: true });
        const isGroup = context.chatType === 'group' && context.chatId != null;
        const title = isGroup && context.threadId == null
          ? (await getFeishuChatTitle(Number(accountId), context.chatId!)) || '飞书Bot会话'
          : '飞书Bot会话';
        const session = await sessionService.createSession(
          user.id, agent.id, title, 'CLOUD', workspace, 'FULL', false,
          'linux', '/bin/bash', 'Linux', model?.id ?? null,
          isGroup ? `feishu-chat-${accountId}-${context.chatId}` : `feishu-${accountId}-private-${user.id}`,
          'new', null, null,
        );
        return { sessionId: session.id!, ownerUserId: user.id, workspace: session.workspace };
      },
    },
    cfg.feishu.bot.groupContext.maxItems,
    cfg.feishu.bot.groupContext.maxMinutes,
    new GroupContextSummarizer(routeChatClient, async (sessionId: number) => {
      const session = await sessionService.getSession(sessionId);
      const model = session?.modelId != null
        ? await modelService.getModel(session.modelId).catch(() => null)
        : await modelService.getDefaultModel();
      if (model == null || model.baseUrl === '' || model.modelId === '') return null;
      return feishuSummarizerModelConfig(model);
    }),
    cfg.feishu.bot.groupContext.overflowItems,
  );

  return { feishuMessageRepository, feishuMessageService, getFeishuClient, getFeishuChatTitle, sendFeishuText };
}
