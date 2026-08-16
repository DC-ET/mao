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
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface UserWeixinPreferenceRepository {
  findByUserId(userId: number): Promise<UserWeixinPreference | null>;
  insert(row: UserWeixinPreference): Promise<void>;
  updateByUserId(row: UserWeixinPreference): Promise<void>;
}

export interface UserTaskPanelPreferenceRepository {
  findByUserId(userId: number): Promise<UserTaskPanelPreference | null>;
  insert(row: UserTaskPanelPreference): Promise<void>;
  updateByUserId(row: UserTaskPanelPreference): Promise<void>;
}
