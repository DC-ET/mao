import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type {
  TaskPanelPreferenceSaveState,
  TaskPanelPreferenceStateWithVersion,
  UserTaskPanelPreference,
  UserTaskPanelPreferenceRepository,
} from './types.js';

/** 保存时 version 不匹配：别的端刚写过这行，客户端应重取后合并再保存。 */
export class TaskPanelPreferenceConflictException extends BusinessException {
  constructor() {
    super(ErrorCode.PREFERENCE_CONFLICT);
  }
}

export class UserTaskPanelPreferenceService {
  constructor(private readonly preferenceRepo: UserTaskPanelPreferenceRepository) {}

  async get(userId: number): Promise<TaskPanelPreferenceStateWithVersion> {
    const row = await this.preferenceRepo.findByUserId(userId);
    if (row == null) {
      return emptyState();
    }
    return {
      groupOrder: parseStringList(row.groupOrder),
      collapsedGroups: parseStringList(row.collapsedGroups),
      groupAliases: parseStringMap(row.groupAliases),
      version: Number(row.version ?? 0),
    };
  }

  /**
   * 保存任务面板偏好。
   *
   * 带 `expectedVersion` 时走乐观锁：若这期间别的端已写过同一行，抛冲突异常而不是
   * 用旧快照覆盖（读-改-整行写本身不是原子的，没有版本号就只能靠 last-write-wins）。
   */
  async save(userId: number, state: TaskPanelPreferenceSaveState): Promise<TaskPanelPreferenceStateWithVersion> {
    const normalized = normalize(state);
    const row = await this.preferenceRepo.findByUserId(userId);
    // 旧客户端不传 groupAliases（undefined）时保留已有别名；显式传 {} 才是清空。
    const aliasesJson =
      normalized.groupAliases !== undefined
        ? writeStringMap(normalized.groupAliases)
        : (row?.groupAliases != null ? row.groupAliases : writeStringMap({}));
    const expectedVersion = state.expectedVersion == null ? null : Number(state.expectedVersion);
    if (row == null) {
      const created: UserTaskPanelPreference = {
        userId,
        groupOrder: writeStringList(normalized.groupOrder),
        collapsedGroups: writeStringList(normalized.collapsedGroups),
        groupAliases: aliasesJson,
        version: 0,
      };
      await this.preferenceRepo.insert(created);
      return { ...normalized, groupAliases: parseStringMap(aliasesJson), version: 0 };
    }
    if (expectedVersion != null && expectedVersion !== Number(row.version ?? 0)) {
      throw new TaskPanelPreferenceConflictException();
    }
    row.groupOrder = writeStringList(normalized.groupOrder);
    row.collapsedGroups = writeStringList(normalized.collapsedGroups);
    row.groupAliases = aliasesJson;
    const updated = await this.preferenceRepo.updateByUserId(row);
    if (!updated) {
      // SELECT 与 UPDATE 之间被并发写入抢先：同样按冲突处理，让客户端重取合并。
      throw new TaskPanelPreferenceConflictException();
    }
    return { ...normalized, groupAliases: parseStringMap(aliasesJson), version: (row.version ?? 0) + 1 };
  }
}

export function emptyState(): TaskPanelPreferenceStateWithVersion {
  return { groupOrder: [], collapsedGroups: [], groupAliases: {}, version: 0 };
}

/** 别名 map 的存储 JSON（MySQL JSON 列，空 map 写 '{}'）。 */
function writeStringMap(values: Record<string, string> | null | undefined): string {
  return JSON.stringify(values ?? {});
}

function normalize(state: TaskPanelPreferenceSaveState): {
  groupOrder: string[];
  collapsedGroups: string[];
  groupAliases?: Record<string, string>;
} {
  return {
    groupOrder: dedupe(state.groupOrder),
    collapsedGroups: dedupe(state.collapsedGroups),
    // undefined = 旧客户端未传，保留已有别名；其余按 map 归一化。
    groupAliases:
      state.groupAliases === undefined || state.groupAliases === null
        ? undefined
        : normalizeAliases(state.groupAliases),
  };
}

/** 别名上限：分组名展示宽度有限，超长名会截断显示。 */
const GROUP_ALIAS_MAX_LENGTH = 50;

/**
 * 归一化别名 map：值 trim、截断 50 字符、剔除空值；剔除不可改名分组（飞书/钉钉分组标签是
 * Agent 身份合成语义，LOCAL:未设置 / CLOUD:临时工作区 是系统语义桶）。
 */
function normalizeAliases(values: Record<string, string> | null | undefined): Record<string, string> {
  if (values == null || typeof values !== 'object' || Array.isArray(values)) {
    return {};
  }
  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(values)) {
    const key = rawKey.trim();
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    if (key.length === 0 || value.length === 0 || !isGroupRenameable(key)) {
      continue;
    }
    result[key] = value.slice(0, GROUP_ALIAS_MAX_LENGTH);
  }
  return result;
}

/** 与前端 `isGroupRenameable`（desktop/src/utils/cloud-project.ts）保持同一规则。 */
export function isGroupRenameable(key: string): boolean {
  if (key.startsWith('LOCAL:')) {
    return key.substring('LOCAL:'.length) !== '未设置';
  }
  if (key.startsWith('CLOUD:')) {
    return key !== 'CLOUD:临时工作区';
  }
  return false;
}

function dedupe(values: string[] | null | undefined): string[] {
  if (values == null || values.length === 0) {
    return [];
  }
  const result: string[] = [];
  for (const value of values) {
    if (value == null) {
      continue;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || result.includes(trimmed)) {
      continue;
    }
    result.push(trimmed);
  }
  return result;
}

function parseStringList(json: unknown): string[] {
  if (json == null) {
    return [];
  }
  if (Array.isArray(json)) {
    return json.filter((v): v is string => typeof v === 'string');
  }
  if (typeof json !== 'string' || json.trim().length === 0) {
    return [];
  }
  try {
    const values = JSON.parse(json) as unknown;
    return Array.isArray(values) ? values.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function writeStringList(values: string[] | null | undefined): string {
  return JSON.stringify(values ?? []);
}

function parseStringMap(json: unknown): Record<string, string> {
  if (json == null) {
    return {};
  }
  if (typeof json === 'object' && !Array.isArray(json)) {
    return toStringMap(json as Record<string, unknown>);
  }
  if (typeof json !== 'string' || json.trim().length === 0) {
    return {};
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? toStringMap(parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toStringMap(source: Record<string, unknown>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === 'string') {
      result[key] = value;
    }
  }
  return result;
}
