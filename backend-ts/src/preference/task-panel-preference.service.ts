import type {
  TaskPanelPreferenceState,
  UserTaskPanelPreference,
  UserTaskPanelPreferenceRepository,
} from './types.js';

export class UserTaskPanelPreferenceService {
  constructor(private readonly preferenceRepo: UserTaskPanelPreferenceRepository) {}

  async get(userId: number): Promise<TaskPanelPreferenceState> {
    const row = await this.preferenceRepo.findByUserId(userId);
    if (row == null) {
      return emptyState();
    }
    return {
      groupOrder: parseStringList(row.groupOrder),
      collapsedGroups: parseStringList(row.collapsedGroups),
    };
  }

  async save(userId: number, state: TaskPanelPreferenceState): Promise<TaskPanelPreferenceState> {
    const normalized = normalize(state);
    const row = await this.preferenceRepo.findByUserId(userId);
    if (row == null) {
      const created: UserTaskPanelPreference = {
        userId,
        groupOrder: writeStringList(normalized.groupOrder),
        collapsedGroups: writeStringList(normalized.collapsedGroups),
      };
      await this.preferenceRepo.insert(created);
    } else {
      row.groupOrder = writeStringList(normalized.groupOrder);
      row.collapsedGroups = writeStringList(normalized.collapsedGroups);
      await this.preferenceRepo.updateByUserId(row);
    }
    return normalized;
  }
}

export function emptyState(): TaskPanelPreferenceState {
  return { groupOrder: [], collapsedGroups: [] };
}

function normalize(state: TaskPanelPreferenceState): TaskPanelPreferenceState {
  return {
    groupOrder: dedupe(state.groupOrder),
    collapsedGroups: dedupe(state.collapsedGroups),
  };
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
