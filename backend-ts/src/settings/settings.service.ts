import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { hasText } from '../common/case.js';
import type { AgentLookup, ModelLookup, SettingsRuntimeConfig, SystemSetting, SystemSettingRepository } from './types.js';

export const WEIXIN_AGENT_ID_KEY = 'weixin.agentId';
export const WEIXIN_MODEL_ID_KEY = 'weixin.modelId';

export class SystemSettingService {
  static readonly WEIXIN_AGENT_ID_KEY = WEIXIN_AGENT_ID_KEY;
  static readonly WEIXIN_MODEL_ID_KEY = WEIXIN_MODEL_ID_KEY;

  constructor(
    private readonly settingRepo: SystemSettingRepository,
    private readonly agentLookup: AgentLookup,
    private readonly modelLookup: ModelLookup,
    private readonly runtime: SettingsRuntimeConfig,
  ) {}

  async list(category?: string | null): Promise<SystemSetting[]> {
    const settings = await this.settingRepo.list(category);
    this.applyRuntimeValues(settings);
    return settings;
  }

  async getValue(key: string): Promise<string | null> {
    const setting = await this.settingRepo.findByKey(key);
    return setting != null ? (setting.value ?? null) : null;
  }

  async update(key: string, value: string | null | undefined): Promise<SystemSetting> {
    const setting = await this.settingRepo.findByKey(key);
    if (!setting) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '系统配置不存在');
    }
    if (setting.editable == null || setting.editable !== 1) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '该配置仅展示，不支持在后台修改');
    }
    await this.validateValue(key, value);
    setting.value = value != null ? value : '';
    await this.settingRepo.updateById(setting);
    return setting;
  }

  private applyRuntimeValues(settings: SystemSetting[]): void {
    const runtimeValues: Record<string, string> = {
      'workspace.root': this.runtime.workspaceRoot,
      'skills.dir': this.runtime.skillsDir,
      'auth.ldap.enabled': String(this.runtime.ldapEnabled && hasText(this.runtime.ldapUrl)),
      'auth.feishu.enabled': String(
        this.runtime.feishuEnabled
          && hasText(this.runtime.feishuAppId)
          && this.runtime.feishuAppId !== '1234567890',
      ),
    };
    for (const setting of settings) {
      if (runtimeValues[setting.settingKey] != null) {
        setting.value = runtimeValues[setting.settingKey];
      }
    }
  }

  private async validateValue(key: string, value: string | null | undefined): Promise<void> {
    if (key === WEIXIN_AGENT_ID_KEY) {
      if (!hasText(value)) {
        return;
      }
      const parsed = parseLongId(value!.trim());
      if (parsed == null) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '微信智能体配置必须是有效的 Agent ID');
      }
      const agent = await this.agentLookup.findById(parsed);
      if (!agent) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '指定的 Agent 不存在');
      }
      return;
    }
    if (key === WEIXIN_MODEL_ID_KEY) {
      if (!hasText(value)) {
        return;
      }
      const parsed = parseLongId(value!.trim());
      if (parsed == null) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '微信模型配置必须是有效的模型 ID');
      }
      const model = await this.modelLookup.findById(parsed);
      if (!model) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '指定的模型不存在');
      }
      return;
    }
    if (!hasText(value)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '配置值不能为空');
    }
    if (key.endsWith('Days') || key.endsWith('Size') || key.endsWith('SizeMb') || key === 'ui.defaultPageSize') {
      const number = Number(value);
      if (!Number.isInteger(number) || number <= 0) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '配置值必须为正整数');
      }
    }
    if (key.endsWith('enabled') && !(value!.toLowerCase() === 'true' || value!.toLowerCase() === 'false')) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '开关值必须为 true 或 false');
    }
  }
}

function parseLongId(value: string): number | null {
  if (!/^-?\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
