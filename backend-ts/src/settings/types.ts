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
}

export interface SettingsRuntimeConfig {
  workspaceRoot: string;
  skillsDir: string;
}

export interface AgentLookup {
  findById(id: number): Promise<{ id?: number } | null>;
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

export interface UploadSettings {
  storageMode: string;
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

export interface OssSettings {
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  sts: {
    regionId: string;
    endpoint: string;
    accessKeyId: string;
    accessKeySecret: string;
    roleArn: string;
    roleSessionName: string;
    expire: number;
    maxSizeMb: number;
  };
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
