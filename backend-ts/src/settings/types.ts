import type { StorageMode } from '@mao/contracts';

export type { StorageMode } from '@mao/contracts';

export interface SystemSetting {
  id?: number;
  settingKey: string;
  value?: string | null;
  category: string;
  description?: string | null;
  editable?: number | null;
  isSecret?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface SystemSettingRepository {
  list(category?: string | null): Promise<SystemSetting[]>;
  findByKey(key: string): Promise<SystemSetting | null>;
  updateById(setting: SystemSetting): Promise<void>;
  /** 事务内执行批量写；任一失败整体回滚。 */
  transaction<T>(fn: (repo: SystemSettingRepository) => Promise<T>): Promise<T>;
}

export interface SettingsRuntimeConfig {
  workspaceRoot: string;
  skillsDir: string;
}

export interface AgentLookup {
  findById(id: number): Promise<{ id?: number; enabled?: number | null } | null>;
}

export interface ModelLookup {
  findById(id: number): Promise<{ id?: number } | null>;
}

export interface LdapSettings {
  enabled: boolean;
  url: string;
  baseDn: string;
  userDn: string;
  password: string;
  userSearchBase: string;
}

export interface FeishuOAuthSettings {
  enabled: boolean;
  appId: string;
  appSecret: string;
  redirectUri: string;
}

/**
 * 实例级钉钉 OAuth 登录配置（V191）。绑定用的登录应用与机器人是两套凭证：
 * 机器人 Client ID / Secret 在「能力 → 钉钉机器人」按机器人各行管理，
 * 这三项是用户授权绑定走的登录应用，必须与机器人同一企业。
 */
export interface DingtalkOauthSettings {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export interface UploadSettings {
  storageMode: StorageMode;
  baseUrl: string;
  maxSizeMb: number;
}

export interface TavilySettings {
  apiKey: string;
  baseUrl: string;
  connectTimeout: number;
  readTimeout: number;
  maxResults: number;
}

export interface TinyFishSettings {
  apiKey: string;
  baseUrl: string;
  connectTimeout: number;
  readTimeout: number;
}

export type WebSearchProvider = 'tavily' | 'tinyfish';

/** 全网搜索（web_search 工具）统一配置：由后台系统设置切换 provider。 */
export interface WebSearchConfig {
  provider: WebSearchProvider;
  tavily: TavilySettings;
  tinyfish: TinyFishSettings;
}

/** 阿里云 OSS（V4 预签名直传）：长期 AK/SK 即可，STS 子配置（oss.sts.*）已废弃不再读取。 */
export interface OssSettings {
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
}

/** 腾讯云 COS（预签名直传）：bucket 含 APPID 后缀（如 name-1250000000）。 */
export interface CosSettings {
  region: string;
  secretId: string;
  secretKey: string;
  bucket: string;
}

/** 华为云 OBS（预签名直传）：endpoint 形如 obs.cn-north-4.myhuaweicloud.com。 */
export interface ObsSettings {
  endpoint: string;
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
}

/**
 * 实例级邮件通知（SMTP）配置（V162）。
 * 缺行 / enabled=false 均表示邮件渠道不可用：用户保存 EMAIL 偏好时拒绝，发送时返回不可重试失败。
 */
export interface EmailSmtpSettings {
  enabled: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPassword: string;
  /** 发件人地址；为空时回落 smtpUser。 */
  fromAddr: string;
  /** true=隐式 TLS（465），false=STARTTLS（587）。 */
  useTls: boolean;
}

/** Agent 运行参数：线程池三元组启动时构建（改后需重启），WS 空闲超时同理。 */
export interface AgentRuntimeSettings {
  threadPoolSize: number;
  threadPoolMax: number;
  threadPoolQueue: number;
  wsIdleTimeoutMs: number;
}

/** 任务通知调度参数：每次调度循环读取，保存后即时生效。 */
export interface NotificationTuningSettings {
  workerDelayMs: number;
  batchSize: number;
  maxAttempts: number;
}

/** harness 调参：均在启动时构建（改后需重启后端）。 */
export interface HarnessTuningSettings {
  compaction: {
    enabled: boolean;
    contextWindowTokens: number;
    triggerRatio: number;
    /** 请求体体积触发阈值（字节）；0 表示关闭体积触发。 */
    triggerPayloadBytes: number;
    maxSummaryTokens: number;
    loopMidwayCompact: boolean;
  };
  llm: {
    rateLimitMaxRetries: number;
    rateLimitRetryDelaySeconds: number;
    rateLimitMaxRetryDelaySeconds: number;
    callTimeoutSeconds: number;
    httpCallTimeoutSeconds: number;
    streamIdleTimeoutSeconds: number;
    /** Anthropic 协议顶层自动缓存断点开关（默认启用）。 */
    anthropicAutoCache: boolean;
    /** Anthropic 缓存 TTL：5m（默认）或 1h。 */
    anthropicCacheTtl: '5m' | '1h';
  };
  webPage: {
    connectTimeout: number;
    readTimeout: number;
    maxRawBytes: number;
    maxOutputLength: number;
    userAgent: string;
  };
  shell: {
    maxSessionsPerConversation: number;
    sessionIdleTimeoutMinutes: number;
    sessionMaxLifetimeHours: number;
  };
}

/** 云端终端参数：启动时构建（改后需重启后端）。 */
export interface TerminalSettings {
  maxSessionsPerTask: number;
  maxSessionsGlobal: number;
  idleTimeoutMinutes: number;
  maxLifetimeHours: number;
  outputBufferBytes: number;
}
