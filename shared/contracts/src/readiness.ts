// 首次成功体验（readiness）——实例就绪度与首启向导状态的跨端契约。
// 消费方：desktop（首启向导 / 空状态分流）、admin（就绪横幅）。

/** 登录者首启向导状态：DONE=三步走完；SKIPPED=跳过（同为完成语义）；AUTO_DONE=存量用户静默视为完成；PENDING=待展示向导。 */
export type OnboardingState = 'DONE' | 'SKIPPED' | 'PENDING' | 'AUTO_DONE';

export interface ReadinessVO {
  /**
   * 默认管理员密码（admin/admin123）是否已修改。仅管理员上下文返回真实值；
   * 非管理员恒为 true，不向普通用户泄漏实例种子状态。
   */
  defaultPasswordChanged: boolean;
  /** 已启用且配置了 API Key 的模型数量。 */
  modelsConfigured: number;
  /** 启用中的 Agent 数量。 */
  agentsEnabled: number;
  /** 当前登录者的首启向导状态。 */
  onboarding: OnboardingState;
}

/** PUT /v1/readiness/onboarding 入参：向导完成或跳过时提交；服务端幂等（已有记录不覆盖）。 */
export interface OnboardingCompleteInput {
  chosenAgentId?: number | null;
  skipped?: boolean;
}
