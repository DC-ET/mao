/**
 * 新建会话模型预填（技术方案 2026-11-24 §8.2）：用户手选 > Agent 默认模型 > 全局默认。
 *
 * 抽成纯函数是为了可测：TaskView 里的编排有请求与竞态，判断规则本身不应被组件细节淹没。
 */

export interface NewTaskModelPrefillInput {
  /** 用户是否在新建态手选过模型（手选后切换 Agent 不覆盖）；缺省视为未手选。 */
  touched?: boolean;
  /** 路由带入 / 上次会话预填的模型 id。 */
  explicitModelId?: number | null;
  /** 当前选中 Agent 的默认模型 id。 */
  agentModelId?: number | null;
  /** 客户端可见模型 id 集合（/models/active?scope=client）。 */
  visibleModelIds: ReadonlySet<number>;
}

export type NewTaskModelPrefillDecision =
  | { action: 'keep' }
  | { action: 'set'; modelId: number }
  | { action: 'global' };

export function decideNewTaskModel(input: NewTaskModelPrefillInput): NewTaskModelPrefillDecision {
  if (input.touched === true) return { action: 'keep' };
  const { explicitModelId, agentModelId, visibleModelIds } = input;
  if (explicitModelId != null) {
    // 显式值仍可用：客户端可见，或恰好是该 Agent 的默认模型（服务端按此放行隐藏模型）
    if (explicitModelId === agentModelId || visibleModelIds.has(explicitModelId)) {
      return { action: 'set', modelId: explicitModelId };
    }
  }
  if (agentModelId != null) return { action: 'set', modelId: agentModelId };
  return { action: 'global' };
}
