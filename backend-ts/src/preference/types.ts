import type { WeixinPreferenceVO, TaskPanelPreferenceState } from '@mao/contracts';
export type { WeixinPreferenceVO, TaskPanelPreferenceState };

export interface UserWeixinPreference {
  userId: number;
  voiceReply?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface UserTaskPanelPreference {
  userId: number;
  groupOrder?: string | string[] | null;
  collapsedGroups?: string | string[] | null;
  groupAliases?: string | Record<string, string> | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface UserWeixinPreferenceRepository {
  findByUserId(userId: number): Promise<UserWeixinPreference | null>;
  insert(row: UserWeixinPreference): Promise<void>;
  updateByUserId(row: UserWeixinPreference): Promise<void>;
}

/** save 入参：groupAliases 为 undefined 表示旧客户端未传，保留已有别名；显式 {} 才清空。 */
export interface TaskPanelPreferenceSaveState {
  groupOrder?: string[];
  collapsedGroups?: string[];
  groupAliases?: Record<string, string> | null;
}

export interface UserTaskPanelPreferenceRepository {
  findByUserId(userId: number): Promise<UserTaskPanelPreference | null>;
  insert(row: UserTaskPanelPreference): Promise<void>;
  updateByUserId(row: UserTaskPanelPreference): Promise<void>;
}
