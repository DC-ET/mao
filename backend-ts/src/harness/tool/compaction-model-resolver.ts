import { harnessLog } from '../log.js';
import { llmModelToConfig } from '../deps.js';
import type { LlmModelConfig } from '../llm/chat-request.js';
import type { LlmModel } from '../../model/types.js';
import { COMPACTION_MODEL_ID_KEY } from '../../settings/settings.service.js';

/**
 * 压缩模型两级解析（技术方案 §5.10）：admin 系统设置 compaction.modelId 优先；
 * 未配置或配置失效（非数字 / 模型不存在 / 已删 / 停用 / model_type 非文本）时回落会话
 * 的 context.modelConfig。仿 ApprovalModelResolver：每次压缩即时解析（不缓存），
 * admin 改配置对下一次压缩生效；scene=compaction 不变，成本归属天然清晰。
 */
export class CompactionModelResolver {
  constructor(
    private readonly settingLookup: (key: string) => Promise<string | null>,
    private readonly modelLookup: (id: number) => Promise<LlmModel | null>,
  ) {}

  async resolve(fallback: LlmModelConfig | null | undefined): Promise<LlmModelConfig | null | undefined> {
    let raw: string | null = null;
    try {
      raw = await this.settingLookup(COMPACTION_MODEL_ID_KEY);
    } catch (e) {
      harnessLog('warn', `Compaction model setting read failed, using session model: ${(e as Error).message}`);
      return fallback;
    }
    const trimmed = (raw ?? '').trim();
    if (trimmed === '') return fallback;
    const id = Number(trimmed);
    if (!Number.isInteger(id) || id <= 0) {
      harnessLog('warn', `compaction.modelId is not a valid model id: ${trimmed}, using session model`);
      return fallback;
    }
    try {
      const model = await this.modelLookup(id);
      if (!model || model.deleted === 1) {
        harnessLog('warn', `compaction.modelId=${id} not found or deleted, using session model`);
        return fallback;
      }
      if (model.status != null && Number(model.status) !== 1) {
        harnessLog('warn', `compaction.modelId=${id} is disabled, using session model`);
        return fallback;
      }
      if ((model.modelType ?? 'text') !== 'text') {
        harnessLog('warn', `compaction.modelId=${id} is not a text model, using session model`);
        return fallback;
      }
      return llmModelToConfig(model);
    } catch (e) {
      harnessLog('warn', `Compaction model lookup failed, using session model: ${(e as Error).message}`);
      return fallback;
    }
  }
}
