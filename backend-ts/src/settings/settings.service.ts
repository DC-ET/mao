import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { hasText } from '../common/case.js';
import { decryptAesGcm, encryptAesGcmNonNull } from '../crypto/aes-gcm.js';
import type {
  AgentLookup, FeishuOAuthSettings, LdapSettings, ModelLookup, OssSettings, SettingsRuntimeConfig,
  SystemSetting, SystemSettingRepository, TavilySettings, TinyFishSettings, UploadSettings, WebSearchConfig, WebSearchProvider,
} from './types.js';

export const WEIXIN_AGENT_ID_KEY = 'weixin.agentId';
export const WEIXIN_MODEL_ID_KEY = 'weixin.modelId';
export const SESSION_TITLE_MODEL_ID_KEY = 'session.titleModelId';
export const GIT_COMMIT_MESSAGE_MODEL_ID_KEY = 'git.commitMessageModelId';

export const LDAP_ENABLED_KEY = 'auth.ldap.enabled';
export const LDAP_URL_KEY = 'auth.ldap.url';
export const LDAP_BASE_DN_KEY = 'auth.ldap.baseDn';
export const LDAP_USER_DN_KEY = 'auth.ldap.userDn';
export const LDAP_PASSWORD_KEY = 'auth.ldap.password';
export const LDAP_USER_SEARCH_BASE_KEY = 'auth.ldap.userSearchBase';
export const FEISHU_ENABLED_KEY = 'auth.feishu.enabled';
export const FEISHU_APP_ID_KEY = 'auth.feishu.appId';
export const FEISHU_APP_SECRET_KEY = 'auth.feishu.appSecret';
export const FEISHU_REDIRECT_URI_KEY = 'auth.feishu.redirectUri';
export const UPLOAD_STORAGE_MODE_KEY = 'upload.storageMode';
export const UPLOAD_BASE_URL_KEY = 'upload.baseUrl';
export const FILE_MAX_SIZE_MB_KEY = 'file.maxSizeMb';
export const TAVILY_API_KEY_KEY = 'tools.tavilyApiKey';
export const TINYFISH_API_KEY_KEY = 'tools.tinyfishApiKey';
export const WEB_SEARCH_PROVIDER_KEY = 'tools.webSearchProvider';
export const OSS_REGION_KEY = 'oss.region';
export const OSS_ACCESS_KEY_ID_KEY = 'oss.accessKeyId';
export const OSS_ACCESS_KEY_SECRET_KEY = 'oss.accessKeySecret';
export const OSS_BUCKET_KEY = 'oss.bucket';
export const OSS_STS_REGION_ID_KEY = 'oss.sts.regionId';
export const OSS_STS_ENDPOINT_KEY = 'oss.sts.endpoint';
export const OSS_STS_ACCESS_KEY_ID_KEY = 'oss.sts.accessKeyId';
export const OSS_STS_ACCESS_KEY_SECRET_KEY = 'oss.sts.accessKeySecret';
export const OSS_STS_ROLE_ARN_KEY = 'oss.sts.roleArn';
export const OSS_STS_ROLE_SESSION_NAME_KEY = 'oss.sts.roleSessionName';
export const OSS_STS_EXPIRE_KEY = 'oss.sts.expire';
export const OSS_STS_MAX_SIZE_MB_KEY = 'oss.sts.maxSizeMb';

/** 掩码回显占位符：secret 行已设置时返回该值。 */
export const SECRET_MASK = '******';

const DEFAULT_LDAP_USER_SEARCH_BASE = 'ou=users';
const DEFAULT_FEISHU_REDIRECT_URI = 'http://localhost:9080/api/v1/auth/feishu/callback';
const DEFAULT_UPLOAD_STORAGE_MODE = 'local';
const DEFAULT_FILE_MAX_SIZE_MB = 50;
const DEFAULT_TAVILY_BASE_URL = 'https://api.tavily.com';
const DEFAULT_TAVILY_CONNECT_TIMEOUT = 10000;
const DEFAULT_TAVILY_READ_TIMEOUT = 30000;
const DEFAULT_TAVILY_MAX_RESULTS = 5;
const DEFAULT_TINYFISH_BASE_URL = 'https://api.search.tinyfish.ai';
const DEFAULT_TINYFISH_CONNECT_TIMEOUT = 10000;
const DEFAULT_TINYFISH_READ_TIMEOUT = 30000;
const DEFAULT_WEB_SEARCH_PROVIDER: WebSearchProvider = 'tavily';
const DEFAULT_OSS_STS_ROLE_SESSION_NAME = 'mao-sts';
const DEFAULT_OSS_STS_EXPIRE = 3600;
const DEFAULT_OSS_STS_MAX_SIZE_MB = 50;

export class SystemSettingService {
  static readonly WEIXIN_AGENT_ID_KEY = WEIXIN_AGENT_ID_KEY;
  static readonly WEIXIN_MODEL_ID_KEY = WEIXIN_MODEL_ID_KEY;
  static readonly SESSION_TITLE_MODEL_ID_KEY = SESSION_TITLE_MODEL_ID_KEY;
  static readonly GIT_COMMIT_MESSAGE_MODEL_ID_KEY = GIT_COMMIT_MESSAGE_MODEL_ID_KEY;

  constructor(
    private readonly settingRepo: SystemSettingRepository,
    private readonly agentLookup: AgentLookup,
    private readonly modelLookup: ModelLookup,
    private readonly runtime: SettingsRuntimeConfig,
    private readonly secretKey = '',
  ) {}

  async list(category?: string | null): Promise<SystemSetting[]> {
    const settings = await this.settingRepo.list(category);
    this.applyRuntimeValues(settings);
    for (const setting of settings) {
      if (setting.isSecret === 1 && hasText(setting.value ?? '')) {
        setting.value = SECRET_MASK;
      }
    }
    return settings;
  }

  async getValue(key: string): Promise<string | null> {
    const setting = await this.settingRepo.findByKey(key);
    return setting != null ? (setting.value ?? null) : null;
  }

  /**
   * 更新单个配置。secret 行语义：value=null 不修改；value='' 清空；其他值加密覆盖。
   * 普通行语义：value=null/'' 均存储为 ''。
   */
  async update(key: string, value: string | null | undefined): Promise<SystemSetting> {
    const setting = await this.settingRepo.findByKey(key);
    if (!setting) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '系统配置不存在');
    }
    if (setting.editable == null || setting.editable !== 1) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '该配置仅展示，不支持在后台修改');
    }
    const next = await this.resolveNextValue(setting, value);
    if (next == null) {
      return this.masked(setting);
    }
    setting.value = next;
    await this.settingRepo.updateById(setting);
    return this.masked(setting);
  }

  /**
   * 批量更新：先对全部条目做存在性/可编辑性/取值校验，任一失败则整体失败；
   * 校验通过后逐条落库。secret 语义同 update。
   */
  async updateBatch(items: Array<{ key: string; value: string | null | undefined }>): Promise<SystemSetting[]> {
    const rows: Array<{ setting: SystemSetting; next: string | null }> = [];
    for (const item of items) {
      const setting = await this.settingRepo.findByKey(item.key);
      if (!setting) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, `系统配置不存在: ${item.key}`);
      }
      if (setting.editable == null || setting.editable !== 1) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, `该配置仅展示，不支持在后台修改: ${item.key}`);
      }
      rows.push({ setting, next: await this.resolveNextValue(setting, item.value) });
    }
    const result: SystemSetting[] = [];
    for (const { setting, next } of rows) {
      if (next == null) {
        result.push(this.masked(setting));
        continue;
      }
      setting.value = next;
      await this.settingRepo.updateById(setting);
      result.push(this.masked(setting));
    }
    return result;
  }

  async getLdapConfig(): Promise<LdapSettings> {
    const [enabled, url, baseDn, userDn, password, userSearchBase] = await Promise.all([
      this.getBool(LDAP_ENABLED_KEY),
      this.getText(LDAP_URL_KEY),
      this.getText(LDAP_BASE_DN_KEY),
      this.getText(LDAP_USER_DN_KEY),
      this.getSecret(LDAP_PASSWORD_KEY),
      this.getText(LDAP_USER_SEARCH_BASE_KEY, DEFAULT_LDAP_USER_SEARCH_BASE),
    ]);
    return { enabled, url, baseDn, userDn, password, userSearchBase };
  }

  async getFeishuOAuthConfig(): Promise<FeishuOAuthSettings> {
    const [enabled, appId, appSecret, redirectUri] = await Promise.all([
      this.getBool(FEISHU_ENABLED_KEY),
      this.getText(FEISHU_APP_ID_KEY),
      this.getSecret(FEISHU_APP_SECRET_KEY),
      this.getText(FEISHU_REDIRECT_URI_KEY, DEFAULT_FEISHU_REDIRECT_URI),
    ]);
    return { enabled, appId, appSecret, redirectUri };
  }

  async getUploadConfig(): Promise<UploadSettings> {
    const [storageModeRaw, baseUrl, maxSizeRaw] = await Promise.all([
      this.getText(UPLOAD_STORAGE_MODE_KEY, DEFAULT_UPLOAD_STORAGE_MODE),
      this.getText(UPLOAD_BASE_URL_KEY),
      this.getText(FILE_MAX_SIZE_MB_KEY),
    ]);
    const maxSizeMb = parsePositiveInt(maxSizeRaw) ?? DEFAULT_FILE_MAX_SIZE_MB;
    const storageMode = storageModeRaw === 'oss' ? 'oss' : 'local';
    return { storageMode, baseUrl, maxSizeMb };
  }

  async getTavilyConfig(): Promise<TavilySettings> {
    const apiKey = await this.getSecret(TAVILY_API_KEY_KEY);
    return {
      apiKey,
      baseUrl: DEFAULT_TAVILY_BASE_URL,
      connectTimeout: DEFAULT_TAVILY_CONNECT_TIMEOUT,
      readTimeout: DEFAULT_TAVILY_READ_TIMEOUT,
      maxResults: DEFAULT_TAVILY_MAX_RESULTS,
    };
  }

  async getTinyFishConfig(): Promise<TinyFishSettings> {
    const apiKey = await this.getSecret(TINYFISH_API_KEY_KEY);
    return {
      apiKey,
      baseUrl: DEFAULT_TINYFISH_BASE_URL,
      connectTimeout: DEFAULT_TINYFISH_CONNECT_TIMEOUT,
      readTimeout: DEFAULT_TINYFISH_READ_TIMEOUT,
    };
  }

  /** 全网搜索统一配置：provider 由后台「网络工具 → 搜索实现」切换，默认 tavily（向后兼容）。 */
  async getWebSearchConfig(): Promise<WebSearchConfig> {
    const [providerRaw, tavily, tinyfish] = await Promise.all([
      this.getText(WEB_SEARCH_PROVIDER_KEY, DEFAULT_WEB_SEARCH_PROVIDER),
      this.getTavilyConfig(),
      this.getTinyFishConfig(),
    ]);
    const provider: WebSearchProvider = providerRaw === 'tinyfish' ? 'tinyfish' : 'tavily';
    return { provider, tavily, tinyfish };
  }

  /** OSS 未配置（region/AK/SK/bucket 任一为空）时返回 null，消费方按"未配置"处理。 */
  async getOssConfig(): Promise<OssSettings | null> {
    const [region, accessKeyId, accessKeySecret, bucket] = await Promise.all([
      this.getText(OSS_REGION_KEY),
      this.getText(OSS_ACCESS_KEY_ID_KEY),
      this.getSecret(OSS_ACCESS_KEY_SECRET_KEY),
      this.getText(OSS_BUCKET_KEY),
    ]);
    if (!hasText(region) || !hasText(accessKeyId) || !hasText(accessKeySecret) || !hasText(bucket)) {
      return null;
    }
    const [regionId, endpoint, stsAccessKeyId, stsAccessKeySecret, roleArn] = await Promise.all([
      this.getText(OSS_STS_REGION_ID_KEY),
      this.getText(OSS_STS_ENDPOINT_KEY),
      this.getText(OSS_STS_ACCESS_KEY_ID_KEY),
      this.getSecret(OSS_STS_ACCESS_KEY_SECRET_KEY),
      this.getText(OSS_STS_ROLE_ARN_KEY),
    ]);
    const [roleSessionNameRaw, expireRaw, maxSizeRaw] = await Promise.all([
      this.getText(OSS_STS_ROLE_SESSION_NAME_KEY),
      this.getText(OSS_STS_EXPIRE_KEY),
      this.getText(OSS_STS_MAX_SIZE_MB_KEY),
    ]);
    return {
      region,
      accessKeyId,
      accessKeySecret,
      bucket,
      sts: {
        regionId,
        endpoint,
        accessKeyId: stsAccessKeyId,
        accessKeySecret: stsAccessKeySecret,
        roleArn,
        roleSessionName: hasText(roleSessionNameRaw) ? roleSessionNameRaw : DEFAULT_OSS_STS_ROLE_SESSION_NAME,
        expire: parsePositiveInt(expireRaw) ?? DEFAULT_OSS_STS_EXPIRE,
        maxSizeMb: parsePositiveInt(maxSizeRaw) ?? DEFAULT_OSS_STS_MAX_SIZE_MB,
      },
    };
  }

  private async resolveNextValue(setting: SystemSetting, value: string | null | undefined): Promise<string | null> {
    if (setting.isSecret === 1) {
      if (value == null) {
        return null;
      }
      if (value === SECRET_MASK) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '不能提交掩码值，请输入新值或留空');
      }
      await this.validateValue(setting.settingKey, value);
      if (value === '') {
        return '';
      }
      return this.encryptSecret(value);
    }
    const normalized = value != null ? value : '';
    await this.validateValue(setting.settingKey, normalized);
    return normalized;
  }

  private encryptSecret(plaintext: string): string {
    if (!hasText(this.secretKey)) {
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, 'SETTINGS_SECRET 未配置，无法保存加密配置项');
    }
    return encryptAesGcmNonNull(plaintext, this.secretKey);
  }

  private decryptSecret(stored: string): string {
    if (!hasText(this.secretKey)) {
      return '';
    }
    try {
      return decryptAesGcm(stored, this.secretKey, '配置解密失败');
    } catch {
      console.error('SystemSetting decrypt failed, treat as unset (SETTINGS_SECRET changed?)');
      return '';
    }
  }

  private masked(setting: SystemSetting): SystemSetting {
    return {
      ...setting,
      value: setting.isSecret === 1 && hasText(setting.value ?? '') ? SECRET_MASK : (setting.value ?? ''),
    };
  }

  private async getBool(key: string): Promise<boolean> {
    const raw = await this.getText(key);
    return raw === 'true' || raw === '1';
  }

  private async getText(key: string, fallback = ''): Promise<string> {
    const setting = await this.settingRepo.findByKey(key);
    const value = setting?.value ?? '';
    return hasText(value) ? value : fallback;
  }

  private async getSecret(key: string): Promise<string> {
    const setting = await this.settingRepo.findByKey(key);
    const stored = setting?.value ?? '';
    return hasText(stored) ? this.decryptSecret(stored) : '';
  }

  private applyRuntimeValues(settings: SystemSetting[]): void {
    const runtimeValues: Record<string, string> = {
      'workspace.root': this.runtime.workspaceRoot,
      'skills.dir': this.runtime.skillsDir,
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
    if (key === WEIXIN_MODEL_ID_KEY || key === SESSION_TITLE_MODEL_ID_KEY || key === GIT_COMMIT_MESSAGE_MODEL_ID_KEY) {
      if (!hasText(value)) {
        return;
      }
      const parsed = parseLongId(value!.trim());
      if (parsed == null) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '模型配置必须是有效的模型 ID');
      }
      const model = await this.modelLookup.findById(parsed);
      if (!model) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '指定的模型不存在');
      }
      return;
    }
    if (!hasText(value)) {
      return;
    }
    if (key.endsWith('Days') || key.endsWith('Size') || key.endsWith('SizeMb') || key === 'ui.defaultPageSize'
      || key === OSS_STS_EXPIRE_KEY) {
      const number = Number(value);
      if (!Number.isInteger(number) || number <= 0) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '配置值必须为正整数');
      }
    }
    if (key.endsWith('enabled') && !(value!.toLowerCase() === 'true' || value!.toLowerCase() === 'false')) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '开关值必须为 true 或 false');
    }
    if (key === UPLOAD_STORAGE_MODE_KEY && value !== 'local' && value !== 'oss') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '上传存储模式仅支持 local 或 oss');
    }
    if (key === WEB_SEARCH_PROVIDER_KEY && value !== 'tavily' && value !== 'tinyfish') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '搜索实现仅支持 tavily 或 tinyfish');
    }
    if (key === LDAP_URL_KEY && !/^ldaps?:\/\//i.test(value!)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'LDAP 服务地址必须以 ldap:// 或 ldaps:// 开头');
    }
    if (key === FEISHU_REDIRECT_URI_KEY && !/^https?:\/\//i.test(value!)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '飞书回调地址必须以 http:// 或 https:// 开头');
    }
    if (key === UPLOAD_BASE_URL_KEY && !/^https?:\/\//i.test(value!)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '上传基础地址必须以 http:// 或 https:// 开头');
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

function parsePositiveInt(value: string | null | undefined): number | null {
  if (!hasText(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}
