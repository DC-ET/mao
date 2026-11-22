import { hasText } from '../common/case.js';
import { WEIXIN_PROJECT_KEY } from '../domain/types.js';
import type { Agent } from '../agent/types.js';
import type { LlmModel } from '../model/types.js';
import type { Session } from '../session/types.js';
import type { ChannelSessionBrief, SessionRepository } from '../session/session.repository.js';
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

/** `/tasks <n>` 切换结果（技术方案 2026-11-22 §4.5）：SWITCHED=已互斥翻转；CURRENT=目标即当前 ACTIVE；REJECTED=不存在/不归属/非本渠道。 */
export type WeixinSwitchSessionResult =
  | { outcome: 'SWITCHED'; session: Session }
  | { outcome: 'CURRENT' }
  | { outcome: 'REJECTED' };

export class WeixinSessionService {
  static readonly PROJECT_KEY = WEIXIN_PROJECT_KEY;

  private readonly userLocks = new Map<number, Promise<void>>();

  constructor(
    private readonly sessionService: SessionService,
    private readonly sessionRepo: SessionRepository,
    private readonly agentService: WeixinAgentLookup,
    private readonly modelService: WeixinModelLookup,
    private readonly systemSettingService: WeixinSettingLookup,
  ) {}

  async getOrCreateWeixinSession(userId: number): Promise<Session> {
    return this.withUserLock(userId, async () => {
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
      return this.createActiveSession(userId, agent.id!, modelId);
    });
  }

  /**
   * `/new`（技术方案 2026-11-22 §4.5）：归档当前 ACTIVE 会话并新建（withUserLock 内，保持 ACTIVE 单行互斥）。
   * 不打断旧会话在跑的执行——旧循环跑完写回旧会话（与飞书 `---`「允许并行」一致）。
   */
  async createNewSession(userId: number): Promise<Session> {
    return this.withUserLock(userId, async () => {
      const agent = await this.resolveWeixinAgent();
      const modelId = await this.resolveWeixinModelId();
      const existing = await this.findExistingWeixinSession(userId);
      if (existing != null) {
        await this.sessionRepo.updateFields(existing.id!, { status: 'ARCHIVED' });
      }
      console.info(`微信 /new 新建会话, userId=${userId}, archived=${existing?.id ?? 'none'}`);
      return this.createActiveSession(userId, agent.id!, modelId);
    });
  }

  /** `/tasks`（技术方案 2026-11-22 §4.2）：本人微信渠道最近会话简报转发。 */
  async listRecentSessions(userId: number, limit: number): Promise<ChannelSessionBrief[]> {
    return this.sessionRepo.listRecentChannelSessionBriefs(userId, 'weixin', limit);
  }

  /**
   * `/tasks <n>` 切换（技术方案 2026-11-22 D4/D5）：归属 + projectKey 校验后 status 互斥翻转。
   * 旧 ACTIVE 会话在跑的执行由 handler 侧先 abort（微信「新会话打断旧执行」心智）。
   */
  async switchSession(userId: number, targetId: number): Promise<WeixinSwitchSessionResult> {
    return this.withUserLock(userId, async () => {
      const target = await this.sessionRepo.findById(targetId);
      if (target == null || target.userId !== userId || target.projectKey !== WEIXIN_PROJECT_KEY) {
        console.warn(`微信 /tasks 切换拒绝: 目标会话不存在/不归属/非本渠道, userId=${userId}, targetId=${targetId}`);
        return { outcome: 'REJECTED' };
      }
      const current = await this.findExistingWeixinSession(userId);
      if (current != null && current.id === target.id) return { outcome: 'CURRENT' };
      if (current != null) {
        await this.sessionRepo.updateFields(current.id!, { status: 'ARCHIVED' });
      }
      await this.sessionRepo.updateFields(targetId, { status: 'ACTIVE' });
      return { outcome: 'SWITCHED', session: { ...target, status: 'ACTIVE' } };
    });
  }

  /** 建新 ACTIVE 会话（getOrCreate 与 /new 共用一份参数，避免两份建会话参数漂移）。 */
  private createActiveSession(userId: number, agentId: number, modelId: number | null): Promise<Session> {
    return this.sessionService.createSession(
      userId,
      agentId,
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
      'weixin',
    );
  }

  /** 同一 userId 的会话创建串行化，避免批内消息并发触发时重复创建会话。 */
  private async withUserLock<T>(userId: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.userLocks.get(userId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((r) => { release = r; });
    // Map 中存链式 Promise（同 weixin/agent-inbound-handler.withSessionLock），
    // 清理时按同一引用比较；若与 current 比较，条件永假导致 Map 条目按 userId 泄漏。
    const chained = prev.then(() => current, () => current);
    this.userLocks.set(userId, chained);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.userLocks.get(userId) === chained) this.userLocks.delete(userId);
    }
  }

  private findExistingWeixinSession(userId: number): Promise<Session | null> {
    return this.sessionRepo.findActiveByUserAndProjectKey(userId, WEIXIN_PROJECT_KEY);
  }

  async resolveWeixinAgent(): Promise<Agent> {
    const configured = await this.systemSettingService.getValue(WEIXIN_AGENT_ID_KEY);
    if (hasText(configured)) {
      try {
        const agentId = Number(configured!.trim());
        const agent = await this.agentService.getAgent(agentId);
        if (agent.enabled === 0) {
          console.warn(`微信智能体已停用 (${configured}), 回退到默认 Agent`);
        } else {
          return agent;
        }
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
