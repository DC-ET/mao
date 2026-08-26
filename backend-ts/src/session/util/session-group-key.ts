import type { Session } from '../types.js';

export const CLOUD_TEMP = 'CLOUD:临时工作区';
export const LOCAL_UNSET = 'LOCAL:未设置';
const FEISHU_GROUP_WORKSPACE = '/feishu-chat/';
const FEISHU_PRIVATE_GROUP_PREFIX = 'FEISHU_PRIVATE:';
const FEISHU_GROUP_PREFIX = 'FEISHU_GROUP:';

export function feishuGroupKey(session: Session): string | null {
  if (session.projectKey != null && /^feishu-\d+-private-\d+$/.test(session.projectKey)) {
    return `${FEISHU_PRIVATE_GROUP_PREFIX}${session.agentId ?? 'null'}`;
  }
  if (session.workspace?.replace(/\\/g, '/').includes(FEISHU_GROUP_WORKSPACE)) {
    return `${FEISHU_GROUP_PREFIX}${session.workspace}`;
  }
  return null;
}

export function isFeishuGroupKey(key: string): boolean {
  return key.startsWith(FEISHU_PRIVATE_GROUP_PREFIX) || key.startsWith(FEISHU_GROUP_PREFIX);
}

export function applyFeishuFilter(groupKey: string): GroupFilterSql {
  if (groupKey.startsWith(FEISHU_PRIVATE_GROUP_PREFIX)) {
    const agentId = groupKey.slice(FEISHU_PRIVATE_GROUP_PREFIX.length);
    return {
      clauses: ['execution_mode = ?', 'agent_id = ?', 'project_key LIKE ?'],
      params: ['CLOUD', agentId === 'null' ? null : Number(agentId), 'feishu-%-private-%'],
    };
  }
  if (groupKey.startsWith(FEISHU_GROUP_PREFIX)) {
    return {
      clauses: ['execution_mode = ?', 'workspace = ?'],
      params: ['CLOUD', groupKey.slice(FEISHU_GROUP_PREFIX.length)],
    };
  }
  throw new Error(`Invalid Feishu groupKey: ${groupKey}`);
}

export interface GroupFilterSql {
  clauses: string[];
  params: unknown[];
}

export function of(sessionOrMode: Session | string | null | undefined, workspace?: string | null): string {
  if (sessionOrMode && typeof sessionOrMode === 'object') {
    return feishuGroupKey(sessionOrMode) ?? ofMode(sessionOrMode.executionMode, sessionOrMode.workspace);
  }
  return ofMode(sessionOrMode as string | null | undefined, workspace);
}

export function ofMode(executionMode: string | null | undefined, workspace: string | null | undefined): string {
  if (executionMode !== 'CLOUD') {
    return workspace != null && workspace.length > 0 ? `LOCAL:${workspace}` : LOCAL_UNSET;
  }
  if (workspace != null && (workspace.includes('/projects/') || workspace.includes(FEISHU_GROUP_WORKSPACE))) {
    return `CLOUD:${workspace}`;
  }
  return CLOUD_TEMP;
}

export function formatLabel(key: string, agentName?: string, groupName?: string): string {
  if (key.startsWith(FEISHU_PRIVATE_GROUP_PREFIX)) {
    return agentName ?? '未知 Agent';
  }
  if (key.startsWith(FEISHU_GROUP_PREFIX)) {
    return `${agentName ?? '未知 Agent'}:${groupName ?? '飞书群聊'}`;
  }
  if (CLOUD_TEMP === key) {
    return '临时工作区';
  }
  if (key.startsWith('CLOUD:')) {
    const ws = key.slice(6);
    const parts = ws.replace(/\\/g, '/').split('/');
    const projectsIdx = parts.indexOf('projects');
    if (projectsIdx >= 0 && projectsIdx < parts.length - 1 && parts[projectsIdx + 1].length > 0) {
      return parts[projectsIdx + 1];
    }
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].length > 0) {
        return parts[i];
      }
    }
    return ws;
  }
  if (key.startsWith('LOCAL:')) {
    const ws = key.slice(6);
    if (ws === '未设置') {
      return '未设置';
    }
    const parts = ws.split('/');
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].length > 0) {
        return parts[i];
      }
    }
    return ws;
  }
  return key;
}

export function compareKeys(a: string, b: string): number {
  if (CLOUD_TEMP === a) return -1;
  if (CLOUD_TEMP === b) return 1;
  const aCloud = a.startsWith('CLOUD:');
  const bCloud = b.startsWith('CLOUD:');
  if (aCloud && !bCloud) return -1;
  if (!aCloud && bCloud) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function applyFilter(groupKey: string | null | undefined): GroupFilterSql {
  if (groupKey == null || groupKey.trim().length === 0) {
    throw new Error('groupKey is required');
  }
  if (isFeishuGroupKey(groupKey)) {
    return applyFeishuFilter(groupKey);
  }
  if (LOCAL_UNSET === groupKey) {
    return {
      clauses: ['execution_mode = ?', '(workspace IS NULL OR workspace = ?)'],
      params: ['LOCAL', ''],
    };
  }
  if (groupKey.startsWith('LOCAL:')) {
    return {
      clauses: ['execution_mode = ?', 'workspace = ?'],
      params: ['LOCAL', groupKey.slice(6)],
    };
  }
  if (CLOUD_TEMP === groupKey) {
    return {
      clauses: ['execution_mode = ?', '(workspace IS NULL OR workspace = ? OR (workspace NOT LIKE ? AND workspace NOT LIKE ?))'],
      params: ['CLOUD', '', '%/projects/%', '%/feishu-chat/%'],
    };
  }
  if (groupKey.startsWith('CLOUD:')) {
    return {
      clauses: ['execution_mode = ?', 'workspace = ?'],
      params: ['CLOUD', groupKey.slice(6)],
    };
  }
  throw new Error(`Invalid groupKey: ${groupKey}`);
}

export function isActivePhase(phase: string | null | undefined): boolean {
  return phase === 'RUNNING' || phase === 'RESUMING' || phase === 'WAITING_APPROVAL';
}

export function compareSessions(a: Session, b: Session): number {
  const aArchived = a.status === 'ARCHIVED';
  const bArchived = b.status === 'ARCHIVED';
  if (aArchived && bArchived) {
    return compareByUpdatedDesc(a, b);
  }
  const aActive = isActivePhase(a.phase);
  const bActive = isActivePhase(b.phase);
  if (aActive !== bActive) {
    return aActive ? -1 : 1;
  }
  const aPin = a.isPinned != null && a.isPinned === 1 ? 1 : 0;
  const bPin = b.isPinned != null && b.isPinned === 1 ? 1 : 0;
  if (aPin !== bPin) {
    return bPin - aPin;
  }
  return compareByUpdatedDesc(a, b);
}

function compareByUpdatedDesc(a: Session, b: Session): number {
  const au = a.updatedAt ?? null;
  const bu = b.updatedAt ?? null;
  if (au == null && bu == null) {
    // fall through
  } else if (au == null) {
    return 1;
  } else if (bu == null) {
    return -1;
  } else {
    const byUpdated = String(bu).localeCompare(String(au));
    if (byUpdated !== 0) {
      return byUpdated;
    }
  }
  const aId = a.id ?? 0;
  const bId = b.id ?? 0;
  return bId === aId ? 0 : bId > aId ? 1 : -1;
}

export const SessionGroupKey = {
  CLOUD_TEMP,
  LOCAL_UNSET,
  of,
  feishuGroupKey,
  isFeishuGroupKey,
  applyFeishuFilter,
  ofMode,
  formatLabel,
  compareKeys,
  applyFilter,
  isActivePhase,
  compareSessions,
};
