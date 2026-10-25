import type { OnboardingState, ReadinessVO } from '@mao/contracts';
import type { UserOnboardingPreferenceRepository } from '../preference/types.js';
import { matchesPassword } from '../crypto/password.js';

/** V001 种子管理员的默认密码；改密判定与种子同源，种子变化时只需改这里（并联动 spec）。 */
export const DEFAULT_ADMIN_PASSWORD = 'admin123';
/** V001 种子管理员的固定 id / 用户名（见 V001__init_schema.sql）。 */
export const SEED_ADMIN_USER_ID = 1;

export interface ReadinessUser {
  id?: number;
  passwordHash?: string | null;
}

export interface ReadinessDeps {
  userLookup: { findById(id: number): Promise<(ReadinessUser & { passwordHash?: string | null }) | null> };
  /** 已启用且配置了 API Key 的模型数量（llm_model.status=1 且 api_key 非空）。 */
  modelsConfiguredCount(): Promise<number>;
  /** 启用中的 Agent 数量（agent.enabled=1 且未删除）。 */
  agentsEnabledCount(): Promise<number>;
  /** 登录者是否存在任意会话历史（存量用户静默判定的分母）。 */
  sessionHistory: { existsByUserId(userId: number): Promise<boolean> };
  onboardingPreference: UserOnboardingPreferenceRepository;
}

export class ReadinessService {
  constructor(private readonly deps: ReadinessDeps) {}

  /**
   * 实例就绪度。defaultPasswordChanged 仅在 isAdmin=true 时返回真实值，
   * 非管理员恒为 true（不泄漏实例种子状态）。
   */
  async getReadiness(userId: number, isAdmin: boolean): Promise<ReadinessVO> {
    const [defaultPasswordChanged, modelsConfigured, agentsEnabled, onboarding] = await Promise.all([
      isAdmin ? this.isDefaultAdminPasswordChanged() : Promise.resolve(true),
      this.deps.modelsConfiguredCount(),
      this.deps.agentsEnabledCount(),
      this.resolveOnboardingState(userId),
    ]);
    return { defaultPasswordChanged, modelsConfigured, agentsEnabled, onboarding };
  }

  /**
   * 向导完成 / 跳过落库。幂等：已有记录（任何状态）不覆盖——
   * 完成语义一旦成立就不可回退，避免多端 / 重复提交把已完成用户拉回向导。
   */
  async completeOnboarding(userId: number, input: { chosenAgentId?: number | null; skipped?: boolean }): Promise<void> {
    const existing = await this.deps.onboardingPreference.findByUserId(userId);
    if (existing != null) return;
    await this.deps.onboardingPreference.insert({
      userId,
      completedAt: input.skipped ? null : new Date(),
      skipped: input.skipped ? 1 : 0,
      chosenAgentId: input.chosenAgentId ?? null,
    });
  }

  private async isDefaultAdminPasswordChanged(): Promise<boolean> {
    const admin = await this.deps.userLookup.findById(SEED_ADMIN_USER_ID);
    // 种子账号不存在（已被删除/重建）视为已改，不再提示。
    if (admin == null || !admin.passwordHash) return true;
    return !(await matchesPassword(DEFAULT_ADMIN_PASSWORD, admin.passwordHash));
  }

  /**
   * onboarding 状态：
   * - 有记录：completed_at 非空 → DONE；skipped=1 → SKIPPED（防御：两者都缺按 DONE）。
   * - 无记录且已有会话历史 → AUTO_DONE（存量用户静默，不回填、不弹窗）。
   * - 其余 → PENDING。
   */
  private async resolveOnboardingState(userId: number): Promise<OnboardingState> {
    const pref = await this.deps.onboardingPreference.findByUserId(userId);
    if (pref != null) {
      if (pref.skipped === 1 && pref.completedAt == null) return 'SKIPPED';
      return 'DONE';
    }
    const hasHistory = await this.deps.sessionHistory.existsByUserId(userId);
    return hasHistory ? 'AUTO_DONE' : 'PENDING';
  }
}
