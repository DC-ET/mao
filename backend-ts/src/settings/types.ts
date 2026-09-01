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
