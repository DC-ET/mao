import { harnessLog } from '../log.js';
import { llmModelToConfig } from '../deps.js';
import type { LlmModelConfig } from '../llm/chat-request.js';
import type { LlmModel } from '../../model/types.js';
import { APPROVAL_MODEL_ID_KEY } from '../../settings/settings.service.js';

/**
 * 审批模型两级解析：admin 系统设置 approval.modelId 优先；未配置或配置失效（非数字、模型不存在/已删除）
 * 时回落 session 的 modelConfig。智能预审与替我审批共用同一解析结果。
 * 每次决策即时读取（不缓存），admin 改配置对下一次决策生效。
 */
export class ApprovalModelResolver {
  constructor(
    private readonly settingLookup: (key: string) => Promise<string | null>,
    private readonly modelLookup: (id: number) => Promise<LlmModel | null>,
  ) {}

  async resolve(fallback: LlmModelConfig | null): Promise<LlmModelConfig | null> {
    let raw: string | null = null;
    try {
      raw = await this.settingLookup(APPROVAL_MODEL_ID_KEY);
    } catch (e) {
      harnessLog('warn', `Approval model setting read failed, using session model: ${(e as Error).message}`);
      return fallback;
    }
    const trimmed = (raw ?? '').trim();
    if (trimmed === '') return fallback;
    const id = Number(trimmed);
    if (!Number.isInteger(id) || id <= 0) {
      harnessLog('warn', `approval.modelId is not a valid model id: ${trimmed}, using session model`);
      return fallback;
    }
    try {
      const model = await this.modelLookup(id);
      if (!model || model.deleted === 1) {
        harnessLog('warn', `approval.modelId=${id} not found or deleted, using session model`);
        return fallback;
      }
      return llmModelToConfig(model);
    } catch (e) {
      harnessLog('warn', `Approval model lookup failed, using session model: ${(e as Error).message}`);
      return fallback;
    }
  }
}
