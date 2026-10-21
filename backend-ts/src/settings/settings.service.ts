import { validateCompanySsoConfig, type CompanySsoConfig } from '../auth/company-sso.config.js';
import { ECP_CONFIG_KEY, parseEcpConfig, type EcpConfig } from '../auth/ecp.config.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { hasText } from '../common/case.js';
import { cidrOverlapsHardDeniedNet, isValidCidr, parseCidrList } from '../common/ssrf.js';
import { decryptAesGcm, encryptAesGcmNonNull } from '../crypto/aes-gcm.js';
import type {
  AgentLookup, AgentRuntimeSettings, BundleRegistrySettings, EmailSmtpSettings, FeishuOAuthSettings, HarnessTuningSettings, LdapSettings, ModelLookup,
  NotificationTuningSettings, OssSettings, SettingsRuntimeConfig, SystemSetting, SystemSettingRepository,
  TavilySettings, TerminalSettings, TinyFishSettings, UploadSettings, WebSearchConfig, WebSearchProvider,
} from './types.js';

export const COMPANY_SSO_CONFIG_KEY = 'auth.companySso.config';

export const WEIXIN_AGENT_ID_KEY = 'weixin.agentId';
/** 管理后台浮窗助手 Agent（V156）；留空回落系统默认 Agent，解析见 embed/embed.routes.ts resolveEmbedAgentId。 */
export const EMBED_AGENT_ID_KEY = 'embed.agentId';
/** 三级环境变量注入总开关（V158，默认开启；关闭后三层变量全部不注入）。 */
export const SHELL_ENV_VARS_ENABLED_KEY = 'shell.envVars.enabled';
/** MCP 工具加载模式全局默认（V159）：working_set=工作集（默认） | full=全量注入。 */
export const MCP_LOAD_MODE_KEY = 'mcp.loadMode';
/** 自定义 HTTP 工具内网放行清单（V163，CIDR JSON 数组）：环回与云元数据永拒，默认空数组=一律按私网拒绝。 */
export const HTTP_TOOL_PRIVATE_ALLOWLIST_KEY = 'tools.http.privateAllowlist';
export const WEIXIN_MODEL_ID_KEY = 'weixin.modelId';
export const SESSION_TITLE_MODEL_ID_KEY = 'session.titleModelId';
export const GIT_COMMIT_MESSAGE_MODEL_ID_KEY = 'git.commitMessageModelId';
export const APPROVAL_MODEL_ID_KEY = 'approval.modelId';
export const MEMORY_EXTRACTION_MODEL_ID_KEY = 'memory.extractionModelId';
/** 哨兵轮询记录保留天数（V148，默认 90）。 */
export const SIGNAL_CHECK_RETENTION_DAYS_KEY = 'signal.checkRetentionDays';
export const COMPACTION_MODEL_ID_KEY = 'compaction.modelId';
export const JEV_ENDPOINT_KEY = 'approval.jev.endpoint';
export const JEV_MODEL_KEY = 'approval.jev.model';
export const JEV_API_KEY_KEY = 'approval.jev.apiKey';

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
export const AGENT_THREAD_POOL_SIZE_KEY = 'agent.threadPoolSize';
export const AGENT_THREAD_POOL_MAX_KEY = 'agent.threadPoolMax';
export const AGENT_THREAD_POOL_QUEUE_KEY = 'agent.threadPoolQueue';
export const WS_IDLE_TIMEOUT_MS_KEY = 'ws.idleTimeoutMs';
export const NOTIFY_WORKER_DELAY_MS_KEY = 'notify.workerDelayMs';
export const NOTIFY_BATCH_SIZE_KEY = 'notify.batchSize';
export const NOTIFY_MAX_ATTEMPTS_KEY = 'notify.maxAttempts';
/** 邮件通知渠道（V162）：7 个设置行，密码行 is_secret=1。缺行/未启用 = 邮件渠道不可用。 */
export const NOTIFY_EMAIL_ENABLED_KEY = 'notify.email.enabled';
export const NOTIFY_EMAIL_SMTP_HOST_KEY = 'notify.email.smtpHost';
export const NOTIFY_EMAIL_SMTP_PORT_KEY = 'notify.email.smtpPort';
export const NOTIFY_EMAIL_SMTP_SECURE_KEY = 'notify.email.smtpSecure';
export const NOTIFY_EMAIL_SMTP_USER_KEY = 'notify.email.smtpUser';
export const NOTIFY_EMAIL_SMTP_PASSWORD_KEY = 'notify.email.smtpPassword';
export const NOTIFY_EMAIL_FROM_ADDR_KEY = 'notify.email.fromAddr';
/** 邮件 SMTP 全部设置 key：保存时的跨字段校验（enabled 时 host/port/fromAddr 必填）按组整体判定。 */
export const NOTIFY_EMAIL_KEYS: readonly string[] = [
  NOTIFY_EMAIL_ENABLED_KEY, NOTIFY_EMAIL_SMTP_HOST_KEY, NOTIFY_EMAIL_SMTP_PORT_KEY,
  NOTIFY_EMAIL_SMTP_SECURE_KEY, NOTIFY_EMAIL_SMTP_USER_KEY, NOTIFY_EMAIL_SMTP_PASSWORD_KEY,
  NOTIFY_EMAIL_FROM_ADDR_KEY,
];

export const SHARE_TOKEN_LINKS_ENABLED_KEY = 'share.tokenLinksEnabled';

export const BUNDLE_REGISTRY_ENABLED_KEY = 'bundle.registry.enabled';
export const BUNDLE_REGISTRY_ACCESS_TOKEN_KEY = 'bundle.registry.accessToken';

const HARNESS_COMPACTION_ENABLED_KEY = 'harness.compaction.enabled';
const HARNESS_COMPACTION_CONTEXT_WINDOW_TOKENS_KEY = 'harness.compaction.contextWindowTokens';
const HARNESS_COMPACTION_TRIGGER_RATIO_KEY = 'harness.compaction.triggerRatio';
const HARNESS_COMPACTION_MAX_SUMMARY_TOKENS_KEY = 'harness.compaction.maxSummaryTokens';
const HARNESS_COMPACTION_LOOP_MIDWAY_KEY = 'harness.compaction.loopMidwayCompact';
const HARNESS_LLM_RATE_LIMIT_MAX_RETRIES_KEY = 'harness.llm.rateLimitMaxRetries';
const HARNESS_LLM_RATE_LIMIT_RETRY_DELAY_SECONDS_KEY = 'harness.llm.rateLimitRetryDelaySeconds';
const HARNESS_LLM_RATE_LIMIT_MAX_RETRY_DELAY_SECONDS_KEY = 'harness.llm.rateLimitMaxRetryDelaySeconds';
const HARNESS_LLM_CALL_TIMEOUT_SECONDS_KEY = 'harness.llm.callTimeoutSeconds';
const HARNESS_LLM_HTTP_CALL_TIMEOUT_SECONDS_KEY = 'harness.llm.httpCallTimeoutSeconds';
const HARNESS_LLM_STREAM_IDLE_TIMEOUT_SECONDS_KEY = 'harness.llm.streamIdleTimeoutSeconds';
const HARNESS_LLM_ANTHROPIC_AUTO_CACHE_KEY = 'harness.llm.anthropicAutoCache';
const HARNESS_LLM_ANTHROPIC_CACHE_TTL_KEY = 'harness.llm.anthropicCacheTtl';
const HARNESS_WEB_PAGE_CONNECT_TIMEOUT_KEY = 'harness.webPage.connectTimeout';
const HARNESS_WEB_PAGE_READ_TIMEOUT_KEY = 'harness.webPage.readTimeout';
const HARNESS_WEB_PAGE_MAX_RAW_BYTES_KEY = 'harness.webPage.maxRawBytes';
const HARNESS_WEB_PAGE_MAX_OUTPUT_LENGTH_KEY = 'harness.webPage.maxOutputLength';
const HARNESS_WEB_PAGE_USER_AGENT_KEY = 'harness.webPage.userAgent';
const HARNESS_SHELL_MAX_SESSIONS_KEY = 'harness.shell.maxSessionsPerConversation';
const HARNESS_SHELL_IDLE_TIMEOUT_MINUTES_KEY = 'harness.shell.sessionIdleTimeoutMinutes';
const HARNESS_SHELL_MAX_LIFETIME_HOURS_KEY = 'harness.shell.sessionMaxLifetimeHours';

const HARNESS_INT_KEYS = new Set([
  HARNESS_COMPACTION_CONTEXT_WINDOW_TOKENS_KEY, HARNESS_COMPACTION_MAX_SUMMARY_TOKENS_KEY,
  HARNESS_LLM_RATE_LIMIT_MAX_RETRIES_KEY, HARNESS_LLM_RATE_LIMIT_RETRY_DELAY_SECONDS_KEY,
  HARNESS_LLM_RATE_LIMIT_MAX_RETRY_DELAY_SECONDS_KEY, HARNESS_LLM_CALL_TIMEOUT_SECONDS_KEY,
  HARNESS_LLM_HTTP_CALL_TIMEOUT_SECONDS_KEY, HARNESS_LLM_STREAM_IDLE_TIMEOUT_SECONDS_KEY,
  HARNESS_WEB_PAGE_CONNECT_TIMEOUT_KEY, HARNESS_WEB_PAGE_READ_TIMEOUT_KEY,
  HARNESS_WEB_PAGE_MAX_RAW_BYTES_KEY, HARNESS_WEB_PAGE_MAX_OUTPUT_LENGTH_KEY,
  HARNESS_SHELL_MAX_SESSIONS_KEY, HARNESS_SHELL_IDLE_TIMEOUT_MINUTES_KEY,
  HARNESS_SHELL_MAX_LIFETIME_HOURS_KEY,
]);
const HARNESS_BOOL_KEYS = new Set([HARNESS_COMPACTION_ENABLED_KEY, HARNESS_COMPACTION_LOOP_MIDWAY_KEY, HARNESS_LLM_ANTHROPIC_AUTO_CACHE_KEY]);

const TERMINAL_MAX_SESSIONS_PER_TASK_KEY = 'terminal.maxSessionsPerTask';
const TERMINAL_MAX_SESSIONS_GLOBAL_KEY = 'terminal.maxSessionsGlobal';
const TERMINAL_IDLE_TIMEOUT_MINUTES_KEY = 'terminal.idleTimeoutMinutes';
const TERMINAL_MAX_LIFETIME_HOURS_KEY = 'terminal.maxLifetimeHours';
const TERMINAL_OUTPUT_BUFFER_BYTES_KEY = 'terminal.outputBufferBytes';

const TERMINAL_INT_KEYS = new Set([
  TERMINAL_MAX_SESSIONS_PER_TASK_KEY, TERMINAL_MAX_SESSIONS_GLOBAL_KEY,
  TERMINAL_IDLE_TIMEOUT_MINUTES_KEY, TERMINAL_MAX_LIFETIME_HOURS_KEY,
  TERMINAL_OUTPUT_BUFFER_BYTES_KEY,
]);

/** 掩码回显占位符：secret 行已设置时返回该值。 */
export const SECRET_MASK = '******';

const DEFAULT_LDAP_USER_SEARCH_BASE = 'ou=users';
const DEFAULT_FEISHU_REDIRECT_URI = 'http://localhost:9080/api/v1/auth/feishu/callback';
const DEFAULT_UPLOAD_STORAGE_MODE = 'local';
const DEFAULT_FILE_MAX_SIZE_MB = 1024;
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
const DEFAULT_AGENT_THREAD_POOL_SIZE = 20;
const DEFAULT_AGENT_THREAD_POOL_MAX = 100;
const DEFAULT_AGENT_THREAD_POOL_QUEUE = 200;
const DEFAULT_WS_IDLE_TIMEOUT_MS = 90000;
const DEFAULT_NOTIFY_WORKER_DELAY_MS = 30000;
const DEFAULT_NOTIFY_BATCH_SIZE = 100;
const DEFAULT_NOTIFY_MAX_ATTEMPTS = 4;
const DEFAULT_NOTIFY_EMAIL_SMTP_PORT = 465;
/** 邮箱格式：与 user.service.ts / 桌面 ProfileView 校验口径一致（不同模块各自持有，避免跨域依赖）。 */
const EMAIL_PATTERN = /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/;
const DEFAULT_HARNESS_WEB_PAGE_USER_AGENT = 'Mozilla/5.0 (compatible; AgentWorkbench/1.0)';

export class SystemSettingService {
  static readonly WEIXIN_AGENT_ID_KEY = WEIXIN_AGENT_ID_KEY;
  static readonly EMBED_AGENT_ID_KEY = EMBED_AGENT_ID_KEY;
  static readonly MCP_LOAD_MODE_KEY = MCP_LOAD_MODE_KEY;
  static readonly WEIXIN_MODEL_ID_KEY = WEIXIN_MODEL_ID_KEY;
  static readonly SESSION_TITLE_MODEL_ID_KEY = SESSION_TITLE_MODEL_ID_KEY;
  static readonly GIT_COMMIT_MESSAGE_MODEL_ID_KEY = GIT_COMMIT_MESSAGE_MODEL_ID_KEY;
  static readonly MEMORY_EXTRACTION_MODEL_ID_KEY = MEMORY_EXTRACTION_MODEL_ID_KEY;

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
        // registry token 特例：解密后掩码 + 尾 4 位（设计约定，便于管理员辨认配置的是哪个 token）；
        // 解密失败（SETTINGS_SECRET 轮换/实例迁移）时给出显式提示——否则管理员侧看不出异常，
        // 而 registry 端点会按"解不开即未开启"失败闭合，表现为莫名 404
        if (setting.settingKey === BUNDLE_REGISTRY_ACCESS_TOKEN_KEY) {
          const plain = this.tryDecryptSecret(setting.value!);
          setting.value = plain != null && hasText(plain)
            ? SECRET_MASK + plain.slice(-4)
            : SECRET_MASK + '（密钥已变更无法解密，请重新填写并保存）';
          continue;
        }
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
   * 环境变量注入总开关（技术方案 §5.1）。行缺失或值非 false/0 一律视为开启：
   * 新能力默认可用；紧急停用必须显式写 false（与 getBool 未设置返回 false 的语义不同）。
   */
  async shellEnvVarsEnabled(): Promise<boolean> {
    const raw = (await this.getText(SHELL_ENV_VARS_ENABLED_KEY)).trim().toLowerCase();
    return raw !== 'false' && raw !== '0';
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
    if (NOTIFY_EMAIL_KEYS.includes(key)) {
      await this.validateEmailSmtpGroup(new Map([[key, next]]));
    }
    if (next == null) {
      return this.masked(setting);
    }
    setting.value = next;
    await this.settingRepo.updateById(setting);
    return this.masked(setting);
  }

  /**
   * 批量更新：先对全部条目做存在性/可编辑性/取值校验，任一失败则整体失败；
   * 校验通过后在单事务内落库，中途失败整体回滚，避免半截配置。
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
    if (rows.some(({ setting }) => NOTIFY_EMAIL_KEYS.includes(setting.settingKey))) {
      await this.validateEmailSmtpGroup(new Map(rows.map(({ setting, next }) => [setting.settingKey, next])));
    }
    return this.settingRepo.transaction(async (tx) => {
      const result: SystemSetting[] = [];
      for (const { setting, next } of rows) {
        if (next == null) {
          result.push(this.masked(setting));
          continue;
        }
        setting.value = next;
        await tx.updateById(setting);
        result.push(this.masked(setting));
      }
      return result;
    });
  }

  async getCompanySsoConfig(): Promise<CompanySsoConfig> {
    const setting = await this.settingRepo.findByKey(COMPANY_SSO_CONFIG_KEY);
    if (!setting) {
      return { enabled: false, allowedDomains: [], allowedOrigins: [], accessTtlSeconds: 1800, timeoutMs: 3000, requireHttps: true };
    }
    return this.parseCompanySsoConfig(setting.value);
  }

  async getEcpConfig(): Promise<EcpConfig> {
    const setting = await this.settingRepo.findByKey(ECP_CONFIG_KEY);
    if (!setting?.value) {
      return parseEcpConfig(null);
    }
    return this.parseEcpConfig(setting.value);
  }

  private parseEcpConfig(value: unknown): EcpConfig {
    try {
      if (typeof value !== 'string') throw new Error();
      return parseEcpConfig(value);
    } catch {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'ECP 配置必须是完整有效的 JSON：enabled、appCode、baseUrl、loginVariant、timeoutMs、desktopCallbackUrl、adminCallbackUrl、larkAppId');
    }
  }

  private parseCompanySsoConfig(value: unknown): CompanySsoConfig {
    try {
      if (typeof value !== 'string') throw new Error();
      const parsed: unknown = JSON.parse(value);
      const keys = ['enabled', 'allowedDomains', 'allowedOrigins', 'accessTtlSeconds', 'timeoutMs'];
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || Object.keys(parsed).length !== keys.length || !keys.every((key) => Object.hasOwn(parsed, key))) throw new Error();
      return validateCompanySsoConfig({ ...parsed, requireHttps: true } as CompanySsoConfig);
    } catch {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '公司 SSO 配置必须是完整有效的 JSON：enabled、allowedDomains、allowedOrigins、accessTtlSeconds（60-3600）、timeoutMs（1-30000），Origin 支持精确 HTTPS、https://*.example.com（可带端口）或全来源 *');
    }
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

  /** 匿名分享链接（P3）：默认关闭。未配置或非 true/1 一律视为关闭。 */
  async shareTokenLinksEnabled(): Promise<boolean> {
    return this.getBool(SHARE_TOKEN_LINKS_ENABLED_KEY);
  }

  /** Bundle registry 只读端点配置（资产分发闭环）：默认关闭，管理员显式开启。 */
  async getBundleRegistryConfig(): Promise<BundleRegistrySettings> {
    const [enabled, row] = await Promise.all([
      this.getBool(BUNDLE_REGISTRY_ENABLED_KEY),
      this.settingRepo.findByKey(BUNDLE_REGISTRY_ACCESS_TOKEN_KEY),
    ]);
    const stored = row?.value ?? '';
    if (!hasText(stored)) {
      // 未配置 token：管理员显式开启即公开只读（无 token 门槛）
      return { enabled, accessToken: null };
    }
    const plain = this.tryDecryptSecret(stored);
    if (plain == null || !hasText(plain)) {
      // 密文解不开（SETTINGS_SECRET 轮换 / 跨实例拷贝 DB）：安全门必须失败闭合——
      // 绝不能回落成"未配置 token"而整体跳过校验，否则资产（含完整 systemPrompt 与技能文件）对任何可访问域名的人全量可读
      return { enabled: false, accessToken: null };
    }
    return { enabled, accessToken: plain };
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

  /** Agent 运行参数：线程池与 WS 超时均在启动时构建，修改后需重启后端生效。 */
  async getAgentRuntimeConfig(): Promise<AgentRuntimeSettings> {
    const [sizeRaw, maxRaw, queueRaw, idleRaw] = await Promise.all([
      this.getText(AGENT_THREAD_POOL_SIZE_KEY),
      this.getText(AGENT_THREAD_POOL_MAX_KEY),
      this.getText(AGENT_THREAD_POOL_QUEUE_KEY),
      this.getText(WS_IDLE_TIMEOUT_MS_KEY),
    ]);
    return {
      threadPoolSize: parsePositiveInt(sizeRaw) ?? DEFAULT_AGENT_THREAD_POOL_SIZE,
      threadPoolMax: parsePositiveInt(maxRaw) ?? DEFAULT_AGENT_THREAD_POOL_MAX,
      threadPoolQueue: parsePositiveInt(queueRaw) ?? DEFAULT_AGENT_THREAD_POOL_QUEUE,
      wsIdleTimeoutMs: parsePositiveInt(idleRaw) ?? DEFAULT_WS_IDLE_TIMEOUT_MS,
    };
  }

  /** 任务通知调度参数：调度器每轮读取，保存后即时生效。 */
  async getNotificationTuningConfig(): Promise<NotificationTuningSettings> {
    const [delayRaw, batchRaw, attemptsRaw] = await Promise.all([
      this.getText(NOTIFY_WORKER_DELAY_MS_KEY),
      this.getText(NOTIFY_BATCH_SIZE_KEY),
      this.getText(NOTIFY_MAX_ATTEMPTS_KEY),
    ]);
    return {
      workerDelayMs: parsePositiveInt(delayRaw) ?? DEFAULT_NOTIFY_WORKER_DELAY_MS,
      batchSize: parsePositiveInt(batchRaw) ?? DEFAULT_NOTIFY_BATCH_SIZE,
      maxAttempts: parsePositiveInt(attemptsRaw) ?? DEFAULT_NOTIFY_MAX_ATTEMPTS,
    };
  }

  /**
   * 邮件通知（SMTP）配置（V162）。发送时实时读取：保存后即时生效，不在服务内缓存。
   * 缺行回落默认值（端口 465 / 隐式 TLS），enabled 缺行视为关闭。
   */
  async getEmailSmtpConfig(): Promise<EmailSmtpSettings> {
    const [enabled, host, portRaw, secureRaw, user, password, fromAddr] = await Promise.all([
      this.getBool(NOTIFY_EMAIL_ENABLED_KEY),
      this.getText(NOTIFY_EMAIL_SMTP_HOST_KEY),
      this.getText(NOTIFY_EMAIL_SMTP_PORT_KEY, String(DEFAULT_NOTIFY_EMAIL_SMTP_PORT)),
      // 缺行回落 V162 seed 默认值：465 + 隐式 TLS
      this.getText(NOTIFY_EMAIL_SMTP_SECURE_KEY, '1'),
      this.getText(NOTIFY_EMAIL_SMTP_USER_KEY),
      this.getSecret(NOTIFY_EMAIL_SMTP_PASSWORD_KEY),
      this.getText(NOTIFY_EMAIL_FROM_ADDR_KEY),
    ]);
    return {
      enabled,
      smtpHost: host.trim(),
      smtpPort: parsePortNumber(portRaw) ?? DEFAULT_NOTIFY_EMAIL_SMTP_PORT,
      smtpUser: user.trim(),
      smtpPassword: password,
      fromAddr: fromAddr.trim(),
      useTls: isEnabledFlag(secureRaw),
    };
  }

  /** 邮件渠道开关窄接口：用户保存 EMAIL 通知偏好前校验（未启用即拒绝）。 */
  async emailSmtpEnabled(): Promise<boolean> {
    return this.getBool(NOTIFY_EMAIL_ENABLED_KEY);
  }

  /** harness 调参：压缩 / LLM / 网页抓取 / Shell 会话。均启动时构建，修改后需重启后端生效。 */
  async getHarnessTuningConfig(): Promise<HarnessTuningSettings> {
    const [
      compactionEnabledRaw, contextWindowRaw, triggerRatioRaw, maxSummaryRaw, loopMidwayRaw,
      rateLimitMaxRetriesRaw, rateLimitRetryDelayRaw, rateLimitMaxRetryDelayRaw,
      callTimeoutRaw, httpCallTimeoutRaw, streamIdleTimeoutRaw,
      anthropicAutoCacheRaw, anthropicCacheTtlRaw,
      webPageConnectRaw, webPageReadRaw, webPageMaxRawBytesRaw, webPageMaxOutputRaw, webPageUserAgentRaw,
      shellMaxSessionsRaw, shellIdleTimeoutRaw, shellMaxLifetimeRaw,
    ] = await Promise.all([
      this.getOpt(HARNESS_COMPACTION_ENABLED_KEY),
      this.getOpt(HARNESS_COMPACTION_CONTEXT_WINDOW_TOKENS_KEY),
      this.getOpt(HARNESS_COMPACTION_TRIGGER_RATIO_KEY),
      this.getOpt(HARNESS_COMPACTION_MAX_SUMMARY_TOKENS_KEY),
      this.getOpt(HARNESS_COMPACTION_LOOP_MIDWAY_KEY),
      this.getOpt(HARNESS_LLM_RATE_LIMIT_MAX_RETRIES_KEY),
      this.getOpt(HARNESS_LLM_RATE_LIMIT_RETRY_DELAY_SECONDS_KEY),
      this.getOpt(HARNESS_LLM_RATE_LIMIT_MAX_RETRY_DELAY_SECONDS_KEY),
      this.getOpt(HARNESS_LLM_CALL_TIMEOUT_SECONDS_KEY),
      this.getOpt(HARNESS_LLM_HTTP_CALL_TIMEOUT_SECONDS_KEY),
      this.getOpt(HARNESS_LLM_STREAM_IDLE_TIMEOUT_SECONDS_KEY),
      this.getOpt(HARNESS_LLM_ANTHROPIC_AUTO_CACHE_KEY),
      this.getOpt(HARNESS_LLM_ANTHROPIC_CACHE_TTL_KEY),
      this.getOpt(HARNESS_WEB_PAGE_CONNECT_TIMEOUT_KEY),
      this.getOpt(HARNESS_WEB_PAGE_READ_TIMEOUT_KEY),
      this.getOpt(HARNESS_WEB_PAGE_MAX_RAW_BYTES_KEY),
      this.getOpt(HARNESS_WEB_PAGE_MAX_OUTPUT_LENGTH_KEY),
      this.getOpt(HARNESS_WEB_PAGE_USER_AGENT_KEY),
      this.getOpt(HARNESS_SHELL_MAX_SESSIONS_KEY),
      this.getOpt(HARNESS_SHELL_IDLE_TIMEOUT_MINUTES_KEY),
      this.getOpt(HARNESS_SHELL_MAX_LIFETIME_HOURS_KEY),
    ]);
    return {
      compaction: {
        enabled: optBool(compactionEnabledRaw, true),
        contextWindowTokens: optPositiveInt(contextWindowRaw, 256000),
        triggerRatio: optRatio(triggerRatioRaw, 0.8),
        maxSummaryTokens: optPositiveInt(maxSummaryRaw, 12000),
        loopMidwayCompact: optBool(loopMidwayRaw, true),
      },
      llm: {
        rateLimitMaxRetries: optPositiveInt(rateLimitMaxRetriesRaw, 10),
        rateLimitRetryDelaySeconds: optPositiveInt(rateLimitRetryDelayRaw, 2),
        rateLimitMaxRetryDelaySeconds: optPositiveInt(rateLimitMaxRetryDelayRaw, 30),
        callTimeoutSeconds: optPositiveInt(callTimeoutRaw, 120),
        httpCallTimeoutSeconds: optPositiveInt(httpCallTimeoutRaw, 180),
        streamIdleTimeoutSeconds: optPositiveInt(streamIdleTimeoutRaw, 300),
        anthropicAutoCache: optBool(anthropicAutoCacheRaw, true),
        anthropicCacheTtl: anthropicCacheTtlRaw === '1h' ? '1h' : '5m',
      },
      webPage: {
        connectTimeout: optPositiveInt(webPageConnectRaw, 10000),
        readTimeout: optPositiveInt(webPageReadRaw, 30000),
        maxRawBytes: optPositiveInt(webPageMaxRawBytesRaw, 1048576),
        maxOutputLength: optPositiveInt(webPageMaxOutputRaw, 50000),
        userAgent: webPageUserAgentRaw ?? DEFAULT_HARNESS_WEB_PAGE_USER_AGENT,
      },
      shell: {
        maxSessionsPerConversation: optPositiveInt(shellMaxSessionsRaw, 30),
        sessionIdleTimeoutMinutes: optPositiveInt(shellIdleTimeoutRaw, 30),
        sessionMaxLifetimeHours: optPositiveInt(shellMaxLifetimeRaw, 2),
      },
    };
  }

  /** 云端终端参数：启动时读取一次并固化到 TerminalManager，改后需重启后端。 */
  async getTerminalConfig(): Promise<TerminalSettings> {
    const [
      maxPerTaskRaw, maxGlobalRaw, idleTimeoutRaw, maxLifetimeRaw, outputBufferRaw,
    ] = await Promise.all([
      this.getOpt(TERMINAL_MAX_SESSIONS_PER_TASK_KEY),
      this.getOpt(TERMINAL_MAX_SESSIONS_GLOBAL_KEY),
      this.getOpt(TERMINAL_IDLE_TIMEOUT_MINUTES_KEY),
      this.getOpt(TERMINAL_MAX_LIFETIME_HOURS_KEY),
      this.getOpt(TERMINAL_OUTPUT_BUFFER_BYTES_KEY),
    ]);
    return {
      maxSessionsPerTask: optPositiveInt(maxPerTaskRaw, 5),
      maxSessionsGlobal: optPositiveInt(maxGlobalRaw, 50),
      idleTimeoutMinutes: optPositiveInt(idleTimeoutRaw, 120),
      maxLifetimeHours: optPositiveInt(maxLifetimeRaw, 24),
      outputBufferBytes: optPositiveInt(outputBufferRaw, 262144),
    };
  }

  /** OSS 未配置（region/AK/SK/bucket 任一为空）时返回 null，消费方按"未配置"处理。 */
  async getOssConfig(): Promise<OssSettings | null> {    const [region, accessKeyId, accessKeySecret, bucket] = await Promise.all([
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

  /**
   * 邮件 SMTP 组保存校验（V162）：enabled=1 时 host / port / fromAddr 必填且合法。
   * 单 key 与 batch 两条路径共用：pending 为本次待写值（secret 的 null=不修改），
   * 未提交的 key 回落已存值，避免 enabled 与 host 同批保存时漏检。
   */
  private async validateEmailSmtpGroup(pending: Map<string, string | null>): Promise<void> {
    const stored = new Map<string, SystemSetting | null>();
    for (const key of NOTIFY_EMAIL_KEYS) {
      stored.set(key, await this.settingRepo.findByKey(key));
    }
    const valueOf = (key: string): string => {
      if (pending.has(key)) {
        return pending.get(key) ?? '';
      }
      return stored.get(key)?.value ?? '';
    };
    if (!isEnabledFlag(valueOf(NOTIFY_EMAIL_ENABLED_KEY))) {
      return;
    }
    if (!hasText(valueOf(NOTIFY_EMAIL_SMTP_HOST_KEY))) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '启用邮件通知前必须填写 SMTP 服务器地址');
    }
    if (parsePortNumber(valueOf(NOTIFY_EMAIL_SMTP_PORT_KEY)) == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '启用邮件通知前必须填写有效的 SMTP 端口（1-65535）');
    }
    if (!EMAIL_PATTERN.test(valueOf(NOTIFY_EMAIL_FROM_ADDR_KEY).trim())) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '启用邮件通知前必须填写有效的邮箱格式发件人地址');
    }
  }

  private async resolveNextValue(setting: SystemSetting, value: string | null | undefined): Promise<string | null> {
    if (setting.settingKey === COMPANY_SSO_CONFIG_KEY) {
      const { requireHttps: _requireHttps, ...config } = this.parseCompanySsoConfig(value);
      return JSON.stringify(config);
    }
    if (setting.settingKey === ECP_CONFIG_KEY) {
      return JSON.stringify(this.parseEcpConfig(value));
    }
    if (setting.isSecret === 1) {
      if (value == null) {
        return null;
      }
      // registry token 回显为「掩码+尾4位」：原样提交视为未修改（其他 secret 键维持掩码值报错）
      if (setting.settingKey === BUNDLE_REGISTRY_ACCESS_TOKEN_KEY && value.startsWith(SECRET_MASK)) {
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

  /** 解密 secret，失败/未配置密钥时返回 null（供需要区分"解不开"与"未配置"的安全门使用）。 */
  private tryDecryptSecret(stored: string): string | null {
    if (!hasText(this.secretKey)) {
      return null;
    }
    try {
      return decryptAesGcm(stored, this.secretKey, '配置解密失败');
    } catch {
      return null;
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

  /** 未设置（NULL/空串）返回 null，由消费方回落代码默认值。 */
  private async getOpt(key: string): Promise<string | null> {
    const setting = await this.settingRepo.findByKey(key);
    const value = setting?.value ?? '';
    return hasText(value) ? value : null;
  }

  private async getSecret(key: string): Promise<string> {
    const setting = await this.settingRepo.findByKey(key);
    const stored = setting?.value ?? '';
    return hasText(stored) ? this.decryptSecret(stored) : '';
  }

  /** 读取 secret 配置并解密；未设置或解密失败返回空串。供需要明文的业务方（如 Jev 前置决策）使用。 */
  async getSecretValue(key: string): Promise<string> {
    return this.getSecret(key);
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

  async getOpenApiCallLogRetentionDays(): Promise<number> {
    const raw = await this.getOpt('openapi.callLogRetentionDays');
    const n = raw == null ? NaN : Number(raw);
    return Number.isInteger(n) && n > 0 ? n : 90;
  }

  /** 哨兵轮询记录保留天数（signal.checkRetentionDays，V148；默认 90）。 */
  async getSignalCheckRetentionDays(): Promise<number> {
    const raw = await this.getOpt('signal.checkRetentionDays');
    const n = raw == null ? NaN : Number(raw);
    return Number.isInteger(n) && n > 0 ? n : 90;
  }

  /**
   * 自定义 HTTP 工具内网放行清单（V163）：CIDR JSON 数组 → 合法 CIDR 列表。
   * 非法/缺失按空数组处理（=一律按私网拒绝，失败即拒绝不放开）。
   */
  async getPrivateAllowlistCidrs(): Promise<string[]> {
    const raw = await this.getText(HTTP_TOOL_PRIVATE_ALLOWLIST_KEY);
    return parseCidrList(raw);
  }

  async isOpenApiTokenAutoDisableEnabled(): Promise<boolean> {
    const raw = await this.getText('openapi.tokenAutoDisable.enabled', 'true');
    return raw === 'true' || raw === '1';
  }

  async getOpenApiTokenAutoDisableThreshold(): Promise<number> {
    const raw = await this.getOpt('openapi.tokenAutoDisableThreshold');
    const n = raw == null ? NaN : Number(raw);
    return Number.isInteger(n) && n > 0 ? n : 10;
  }

  private async validateValue(key: string, value: string | null | undefined): Promise<void> {
    if (key === WEIXIN_AGENT_ID_KEY || key === EMBED_AGENT_ID_KEY) {
      await this.validateAgentIdSetting(key, value, key === WEIXIN_AGENT_ID_KEY ? '微信智能体' : '浮窗助手');
      return;
    }
    if (key === WEIXIN_MODEL_ID_KEY || key === SESSION_TITLE_MODEL_ID_KEY || key === GIT_COMMIT_MESSAGE_MODEL_ID_KEY
      || key === APPROVAL_MODEL_ID_KEY || key === MEMORY_EXTRACTION_MODEL_ID_KEY
      || key === COMPACTION_MODEL_ID_KEY) {
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
    if (key.endsWith('Days') || key.endsWith('Size') || key.endsWith('SizeMb')
      || key === OSS_STS_EXPIRE_KEY || key.endsWith('TimeoutMs') || key.endsWith('DelayMs')
      || key === NOTIFY_BATCH_SIZE_KEY || key === NOTIFY_MAX_ATTEMPTS_KEY
      || key === AGENT_THREAD_POOL_SIZE_KEY || key === AGENT_THREAD_POOL_MAX_KEY || key === AGENT_THREAD_POOL_QUEUE_KEY
      || key === 'openapi.tokenAutoDisableThreshold') {
      const number = Number(value);
      if (!Number.isInteger(number) || number <= 0) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '配置值必须为正整数');
      }
    }
    if (key.endsWith('enabled') && !(value!.toLowerCase() === 'true' || value!.toLowerCase() === 'false')) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '开关值必须为 true 或 false');
    }
    if ((HARNESS_INT_KEYS.has(key) || TERMINAL_INT_KEYS.has(key)) && (parsePositiveInt(value) == null)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '配置值必须为正整数');
    }
    if (key === HARNESS_COMPACTION_TRIGGER_RATIO_KEY) {
      const ratio = Number(value);
      if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '压缩触发比例必须为 0~1 之间的小数');
      }
    }
    if (HARNESS_BOOL_KEYS.has(key) && !(value!.toLowerCase() === 'true' || value!.toLowerCase() === 'false')) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '开关值必须为 true 或 false');
    }
    if (key === HARNESS_LLM_ANTHROPIC_CACHE_TTL_KEY && value !== '5m' && value !== '1h') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '缓存 TTL 仅支持 5m 或 1h');
    }
    if (key === UPLOAD_STORAGE_MODE_KEY && value !== 'local' && value !== 'oss') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '上传存储模式仅支持 local 或 oss');
    }
    if (key === HTTP_TOOL_PRIVATE_ALLOWLIST_KEY) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value!);
      } catch {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '内网放行清单必须是 JSON 数组，如 ["10.0.0.0/8"]');
      }
      if (!Array.isArray(parsed)) {
        throw new BusinessException(
          ErrorCode.PARAM_INVALID,
          '内网放行清单必须是 JSON 数组（CIDR 列表），如 ["10.0.0.0/8","192.168.1.0/24"]',
        );
      }
      if (!parsed.every((item) => typeof item === 'string' && isValidCidr(item))) {
        throw new BusinessException(
          ErrorCode.PARAM_INVALID,
          '内网放行清单必须是 CIDR 数组（IPv4，可带 /前缀，如 ["10.0.0.0/8","192.168.1.0/24"]）；环回与云元数据端点永不允许放行',
        );
      }
      // 文案声称永不放行的段必须在保存时就拒掉：执行内核虽另有硬拒兜底，
      // 但静默接受会让管理员得到「配了却不生效」的项，排查时没有任何反馈。
      const hardDenied = (parsed as string[]).filter((item) => cidrOverlapsHardDeniedNet(item));
      if (hardDenied.length > 0) {
        throw new BusinessException(
          ErrorCode.PARAM_INVALID,
          `内网放行清单不允许包含环回（127.0.0.0/8）或云元数据（169.254.169.254）网段：${hardDenied.slice(0, 3).join('、')}`,
        );
      }
      return;
    }
    if (key === WEB_SEARCH_PROVIDER_KEY && value !== 'tavily' && value !== 'tinyfish') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '搜索实现仅支持 tavily 或 tinyfish');
    }
    if (key === LDAP_URL_KEY && !/^ldaps?:\/\//i.test(value!)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'LDAP 服务地址必须以 ldap:// 或 ldaps:// 开头');
    }
    if (key === NOTIFY_EMAIL_SMTP_PORT_KEY && parsePortNumber(value) == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'SMTP 端口必须是 1-65535 之间的整数');
    }
    if (key === NOTIFY_EMAIL_FROM_ADDR_KEY && !EMAIL_PATTERN.test(value!.trim())) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '发件人地址必须是有效的邮箱格式');
    }
    if (key === NOTIFY_EMAIL_SMTP_SECURE_KEY && !/^(true|false|1|0)$/i.test(value!.trim())) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'TLS 开关值必须为 true / false 或 1 / 0');
    }
    if (key === FEISHU_REDIRECT_URI_KEY && !/^https?:\/\//i.test(value!)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '飞书回调地址必须以 http:// 或 https:// 开头');
    }
    if (key === UPLOAD_BASE_URL_KEY && !/^https?:\/\//i.test(value!)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '上传基础地址必须以 http:// 或 https:// 开头');
    }
  }

  /**
   * Agent ID 类配置（weixin.agentId / embed.agentId）保存校验：空值放行（回落默认 Agent 语义）；
   * 非数字 / Agent 不存在 / 新指向已停用 Agent 一律拒绝（值与存量相同则豁免，允许保存其他字段）。
   */
  private async validateAgentIdSetting(key: string, value: string | null | undefined, label: string): Promise<void> {
    if (!hasText(value)) {
      return;
    }
    const parsed = parseLongId(value!.trim());
    if (parsed == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `${label}配置必须是有效的 Agent ID`);
    }
    const agent = await this.agentLookup.findById(parsed);
    if (!agent) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '指定的 Agent 不存在');
    }
    if (agent.enabled === 0) {
      const current = (await this.settingRepo.findByKey(key))?.value ?? '';
      if (current.trim() !== value!.trim()) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '指定的 Agent 已停用');
      }
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

/** SMTP 端口合法区间 1-65535；越界/非整数按未配置处理（回落默认 465）。 */
function parsePortNumber(value: string | null | undefined): number | null {
  if (!hasText(value)) {
    return null;
  }
  const parsed = Number(value!.trim());
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535 ? parsed : null;
}

/** 设置行布尔语义：true / 1（大小写不敏感）为开，其余（含空）为关。 */
function isEnabledFlag(raw: string | null | undefined): boolean {
  const normalized = (raw ?? '').trim().toLowerCase();
  return normalized === 'true' || normalized === '1';
}

function optBool(raw: string | null, fallback: boolean): boolean {
  if (raw == null) return fallback;
  // 与 validateValue 的开关校验口径一致（大小写不敏感），避免 'True' 能写入却被回落成默认值
  const normalized = raw.toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0' || normalized === '') return false;
  return fallback;
}

function optPositiveInt(raw: string | null, fallback: number): number {
  return parsePositiveInt(raw) ?? fallback;
}

function optRatio(raw: string | null, fallback: number): number {
  if (raw == null) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 1 ? parsed : fallback;
}
