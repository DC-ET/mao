import { harnessLog } from '../log.js';
import type { LlmModel } from '../../model/types.js';

/**
 * 特色工具模型统一解析器（技术方案 2026-11-27「特色工具模型：默认模型 + Agent 指定模型」）。
 *
 * 同一个实例同时服务两道门，避免「工具是否注入」和「工具执行时取哪个模型」各查一套、口径漂移：
 * - 门控（HarnessService.buildContext）：resolveImageModel / resolveAudioModel 直接传已加载的 agent；
 * - 工具执行（generate_image / edit_image / text_to_speech）：resolve*ForAgent 按 agentId 重新加载
 *   （Tool 执行层只拿得到 agentId）。
 *
 * 解析链（fail-closed）：
 * - Agent 已绑定：只认绑定模型；绑定模型被停用 / 删除 / 类型不匹配 / 协议不兼容 → null（不回退默认）；
 * - 未绑定：显式默认（is_default=1 且启用，audio 额外要求协议兼容）→ 首个启用（改造前行为兜底）→ null。
 */

/** 门控侧所需的 Agent 最小形状（deps.ts 的 Agent 天然满足）。 */
export interface FeaturedModelAgent {
  imageModelId?: number | null;
  audioModelId?: number | null;
}

/** resolver 依赖的模型查询端口（MysqlLlmModelRepository 天然满足）。 */
export interface FeaturedModelModelLookup {
  findById(id: number): Promise<LlmModel | null>;
  /** 类型默认：is_default=1 且启用、未软删；audio 额外要求 OpenAI 兼容协议。 */
  findDefaultByType(modelType: string): Promise<LlmModel | null>;
  /** 首个启用兜底（改造前行为）。 */
  findFirstActiveByType(modelType: string): Promise<LlmModel | null>;
  /** 首个启用且 OpenAI 兼容的语音模型兜底（改造前行为）。 */
  findFirstActiveAudioModel(): Promise<LlmModel | null>;
}

/** resolve*ForAgent 所需的 Agent 查询端口（MysqlAgentRepository 天然满足）。 */
export interface FeaturedModelAgentLookup {
  selectById(id: number): Promise<FeaturedModelAgent | null>;
}

export interface FeaturedModelResolver {
  /** 门控用：直接传已加载的 agent，避免重复查库。 */
  resolveImageModel(agent: FeaturedModelAgent | null): Promise<LlmModel | null>;
  resolveAudioModel(agent: FeaturedModelAgent | null): Promise<LlmModel | null>;
  /** 工具执行用：按 agentId 重新加载 agent；agent 不存在按未绑定处理（走默认链）。 */
  resolveImageModelForAgent(agentId: number | null): Promise<LlmModel | null>;
  resolveAudioModelForAgent(agentId: number | null): Promise<LlmModel | null>;
}

/** OpenAI 兼容语音模型判定（与 MysqlLlmModelRepository 的 audio 协议过滤同口径）。 */
function isOpenAiCompatibleAudio(model: LlmModel): boolean {
  const protocol = (model.apiProtocol ?? '').trim();
  return protocol === '' || protocol === 'openai-compatible';
}

export class DefaultFeaturedModelResolver implements FeaturedModelResolver {
  constructor(
    private readonly modelLookup: FeaturedModelModelLookup,
    private readonly agentLookup: FeaturedModelAgentLookup,
  ) {}

  resolveImageModel(agent: FeaturedModelAgent | null): Promise<LlmModel | null> {
    return this.resolve(agent?.imageModelId, 'image');
  }

  resolveAudioModel(agent: FeaturedModelAgent | null): Promise<LlmModel | null> {
    return this.resolve(agent?.audioModelId, 'audio');
  }

  async resolveImageModelForAgent(agentId: number | null): Promise<LlmModel | null> {
    return this.resolveImageModel(await this.loadAgent(agentId));
  }

  async resolveAudioModelForAgent(agentId: number | null): Promise<LlmModel | null> {
    return this.resolveAudioModel(await this.loadAgent(agentId));
  }

  /** 工具执行端口适配（ImageModelLookup）：generate_image / edit_image 用，与 resolveImageModelForAgent 同义。 */
  findImageModel(agentId: number | null): Promise<LlmModel | null> {
    return this.resolveImageModelForAgent(agentId);
  }

  /** 工具执行端口适配（AudioModelLookup）：text_to_speech 用，与 resolveAudioModelForAgent 同义。 */
  findAudioModel(agentId: number | null): Promise<LlmModel | null> {
    return this.resolveAudioModelForAgent(agentId);
  }

  private async loadAgent(agentId: number | null): Promise<FeaturedModelAgent | null> {
    if (agentId == null) return null;
    return this.agentLookup.selectById(agentId);
  }

  private async resolve(
    boundId: number | null | undefined,
    kind: 'image' | 'audio',
  ): Promise<LlmModel | null> {
    if (boundId != null) {
      // 显式绑定失效（停用/删除/类型错/协议不兼容）：fail-closed，不回退默认——
      // 「指定模型」是明确意图，静默切换可能产生费用、内容风格或协议差异。
      const model = await this.modelLookup.findById(boundId);
      const usable = model != null
        && model.status === 1
        && (model.modelType ?? null) === kind
        && (kind !== 'audio' || isOpenAiCompatibleAudio(model));
      if (!usable) {
        harnessLog('warn', `[featured-model] kind=${kind} bound=${boundId} 绑定模型不可用（停用/删除/类型或协议不匹配），对应能力本会话不可用`);
        return null;
      }
      return model;
    }
    // 未绑定：显式默认 → 首个启用（保持改造前行为）。
    const explicit = await this.modelLookup.findDefaultByType(kind);
    if (explicit != null) return explicit;
    return kind === 'audio'
      ? this.modelLookup.findFirstActiveAudioModel()
      : this.modelLookup.findFirstActiveByType('image');
  }
}
