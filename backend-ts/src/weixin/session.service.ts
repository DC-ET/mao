import { hasText } from '../common/case.js';
import { WEIXIN_PROJECT_KEY } from '../domain/types.js';
import type { Agent } from '../agent/types.js';
import type { LlmModel } from '../model/types.js';
import type { Session } from '../session/types.js';
import type { SessionRepository } from '../session/session.repository.js';
import type { SessionService } from '../session/session.service.js';
import { WEIXIN_AGENT_ID_KEY, WEIXIN_MODEL_ID_KEY } from '../settings/settings.service.js';

export interface WeixinAgentLookup {
  getAgent(id: number): Promise<Agent>;
  requireDefaultAgent(): Promise<Agent>;
}

export interface WeixinModelLookup {
  getModel(id: number): Promise<LlmModel>;
  getDefaultModel(): Promise<LlmModel | null>;
}

export interface WeixinSettingLookup {
  getValue(key: string): Promise<string | null>;
}

export class WeixinSessionService {
  static readonly PROJECT_KEY = WEIXIN_PROJECT_KEY;

  constructor(
    private readonly sessionService: SessionService,
    private readonly sessionRepo: SessionRepository,
    private readonly agentService: WeixinAgentLookup,
    private readonly modelService: WeixinModelLookup,
    private readonly systemSettingService: WeixinSettingLookup,
  ) {}

  async getOrCreateWeixinSession(userId: number): Promise<Session> {
    const agent = await this.resolveWeixinAgent();
    const modelId = await this.resolveWeixinModelId();
    const existingSession = await this.findExistingWeixinSession(userId);
    if (existingSession != null) {
      let changed = false;
      if (agent.id !== existingSession.agentId) {
        console.info(`微信会话切换 Agent, userId=${userId}, sessionId=${existingSession.id}, oldAgentId=${existingSession.agentId}, newAgentId=${agent.id}`);
        existingSession.agentId = agent.id;
        changed = true;
      }
      if (modelId !== existingSession.modelId) {
        console.info(`微信会话切换模型, userId=${userId}, sessionId=${existingSession.id}, oldModelId=${existingSession.modelId}, newModelId=${modelId}`);
        existingSession.modelId = modelId;
        changed = true;
      }
      if (changed) {
        await this.sessionRepo.updateById(existingSession);
      }
      return existingSession;
    }
    console.info(`创建新的微信Bot会话, userId=${userId}, agentId=${agent.id}, modelId=${modelId}`);
    return this.sessionService.createSession(
      userId,
      agent.id!,
      '微信Bot会话',
      'CLOUD',
      null,
      'FULL',
      false,
      'linux',
      '/bin/bash',
      'Linux',
      modelId,
      WEIXIN_PROJECT_KEY,
      'new',
      null,
      null,
    );
  }

  private findExistingWeixinSession(userId: number): Promise<Session | null> {
    return this.sessionRepo.findActiveByUserAndProjectKey(userId, WEIXIN_PROJECT_KEY);
  }

  async resolveWeixinAgent(): Promise<Agent> {
    const configured = await this.systemSettingService.getValue(WEIXIN_AGENT_ID_KEY);
    if (hasText(configured)) {
      try {
        const agentId = Number(configured!.trim());
        return await this.agentService.getAgent(agentId);
      } catch (e) {
        console.warn(`微信智能体配置无效 (${configured}), 回退到默认 Agent: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return this.agentService.requireDefaultAgent();
  }

  async resolveWeixinModelId(): Promise<number | null> {
    const configured = await this.systemSettingService.getValue(WEIXIN_MODEL_ID_KEY);
    if (hasText(configured)) {
      try {
        const modelId = Number(configured!.trim());
        return (await this.modelService.getModel(modelId)).id!;
      } catch (e) {
        console.warn(`微信模型配置无效 (${configured}), 回退到默认模型: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const defaultModel = await this.modelService.getDefaultModel();
    return defaultModel != null ? defaultModel.id! : null;
  }
}
