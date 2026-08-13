export interface SystemSetting {
  id?: number;
  settingKey: string;
  value?: string | null;
  category: string;
  description?: string | null;
  editable?: number | null;
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
  ldapEnabled: boolean;
  ldapUrl: string;
  feishuEnabled: boolean;
  feishuAppId: string;
}

export interface AgentLookup {
  findById(id: number): Promise<{ id?: number } | null>;
}

export interface ModelLookup {
  findById(id: number): Promise<{ id?: number } | null>;
}
