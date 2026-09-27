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
  /** 乐观锁版本号：save 时按读到的 version 更新，冲突抛 PREFERENCE_CONFLICT。 */
  version?: number | null;
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
  /** 客户端读到的版本号；缺省表示不校验（旧客户端/首次保存）。 */
  expectedVersion?: number | null;
}

/** contracts 里的状态加 version（乐观锁版本号，每次保存 +1）。 */
export interface TaskPanelPreferenceStateWithVersion extends TaskPanelPreferenceState {
  version: number;
}

export interface UserTaskPanelPreferenceRepository {
  findByUserId(userId: number): Promise<UserTaskPanelPreference | null>;
  insert(row: UserTaskPanelPreference): Promise<void>;
  /** 带版本号的增量更新：version 不匹配时返回 false（并发写被检测出来，不再静默覆盖）。 */
  updateByUserId(row: UserTaskPanelPreference): Promise<boolean>;
}
