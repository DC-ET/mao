import type { MysqlFeishuBotRepository } from './feishu/feishu_bot.repository.js';
import type { SessionService } from './session/session.service.js';
import type { SessionRepository } from './session/session.repository.js';
import type { AgentService } from './agent/agent.service.js';
import type { ModelService } from './model/model.service.js';
import type { FeishuInboundContext } from './feishu/types.js';

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
