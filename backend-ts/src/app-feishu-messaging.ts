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

/**
 * 新会话标题（D6）：pendingTitle（群 `/new` 新建）或非话题群缺省外 → 固定「飞书Bot会话」+ 待命名标志，
 * 首条真正的 @ 再生成 LLM 短标题；普通非话题群取群名（空回落默认）。
 * pendingTitle 不取群名——否则每次 /new 都叫同一个群名，任务列表里分不开，且群名补写会覆盖短标题。
 */
export function feishuSessionTitleOf(options: { pendingTitle?: boolean; isGroup: boolean; isThread: boolean; groupTitle: string }): string {
  if (options.pendingTitle || !options.isGroup || options.isThread) return '飞书Bot会话';
  return options.groupTitle || '飞书Bot会话';
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
      create: async (accountId: string, context: FeishuInboundContext, options?: { pendingTitle?: boolean }) => {
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
        // pendingTitle（群 /new 新会话）：跳过群名，标题固定「飞书Bot会话」+ 待命名标志，首条真正的 @ 再生成短标题。
        // 否则每次 /new 都叫同一个群名，任务列表里分不开，且群名补写会覆盖短标题。
        const title = feishuSessionTitleOf({
          pendingTitle: options?.pendingTitle === true,
          isGroup,
          isThread: context.threadId != null,
          groupTitle: isGroup ? await getFeishuChatTitle(Number(accountId), context.chatId!) : '',
        });
        const session = await sessionService.createSession(
          user.id, agent.id, title, 'CLOUD', workspace, 'FULL', false,
          'linux', '/bin/bash', 'Linux', model?.id ?? null,
          isGroup ? `feishu-chat-${accountId}-${context.chatId}` : `feishu-${accountId}-private-${user.id}`,
          'new', null, null, 'feishu',
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
