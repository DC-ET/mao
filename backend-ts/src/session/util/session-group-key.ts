import type { Session } from '../types.js';

export const CLOUD_TEMP = 'CLOUD:临时工作区';
export const LOCAL_UNSET = 'LOCAL:未设置';
/** Web 嵌入 SDK（source=embed）会话按 Agent 独立分组：EMBED:{agentId}，与工作区路径无关。 */
export const EMBED_PREFIX = 'EMBED:';
/** 信号哨兵会话（source=signal）独立分组：一个用户的全部哨兵会话进同一组，不带 agentId。 */
export const SIGNAL_GROUP_KEY = 'SIGNAL';
const FEISHU_GROUP_WORKSPACE = '/feishu-chat/';
const FEISHU_PRIVATE_GROUP_PREFIX = 'FEISHU_PRIVATE:';
const FEISHU_GROUP_PREFIX = 'FEISHU_GROUP:';
const DINGTALK_GROUP_WORKSPACE = '/dingtalk-chat/';
const DINGTALK_PRIVATE_GROUP_PREFIX = 'DINGTALK_PRIVATE:';
const DINGTALK_GROUP_PREFIX = 'DINGTALK_GROUP:';

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

export function dingtalkGroupKey(session: Session): string | null {
  if (session.projectKey != null && /^dingtalk-\d+-private-\d+$/.test(session.projectKey)) {
    return `${DINGTALK_PRIVATE_GROUP_PREFIX}${session.agentId ?? 'null'}`;
  }
  if (session.workspace?.replace(/\\/g, '/').includes(DINGTALK_GROUP_WORKSPACE)) {
    return `${DINGTALK_GROUP_PREFIX}${session.workspace}`;
  }
  return null;
}

export function isDingtalkGroupKey(key: string): boolean {
  return key.startsWith(DINGTALK_PRIVATE_GROUP_PREFIX) || key.startsWith(DINGTALK_GROUP_PREFIX);
}

/** `agent_id = NULL` 在 SQL 里永不成立；空 Agent 必须写成 IS NULL（与 EMBED:null 同一口径）。 */
function privateAgentFilter(rawAgentId: string): { clause: string; params: unknown[] } {
  if (rawAgentId === 'null') {
    return { clause: 'agent_id IS NULL', params: [] };
  }
  return { clause: 'agent_id = ?', params: [Number(rawAgentId)] };
}

export function applyDingtalkFilter(groupKey: string): GroupFilterSql {
  if (groupKey.startsWith(DINGTALK_PRIVATE_GROUP_PREFIX)) {
    const agent = privateAgentFilter(groupKey.slice(DINGTALK_PRIVATE_GROUP_PREFIX.length));
    return {
      clauses: ['execution_mode = ?', agent.clause, 'project_key LIKE ?'],
      params: ['CLOUD', ...agent.params, 'dingtalk-%-private-%'],
    };
  }
  if (groupKey.startsWith(DINGTALK_GROUP_PREFIX)) {
    return {
      clauses: ['execution_mode = ?', 'workspace = ?'],
      params: ['CLOUD', groupKey.slice(DINGTALK_GROUP_PREFIX.length)],
    };
  }
  throw new Error(`Invalid Dingtalk groupKey: ${groupKey}`);
}

export function applyFeishuFilter(groupKey: string): GroupFilterSql {
  if (groupKey.startsWith(FEISHU_PRIVATE_GROUP_PREFIX)) {
    const agent = privateAgentFilter(groupKey.slice(FEISHU_PRIVATE_GROUP_PREFIX.length));
    return {
      clauses: ['execution_mode = ?', agent.clause, 'project_key LIKE ?'],
      params: ['CLOUD', ...agent.params, 'feishu-%-private-%'],
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
    if (sessionOrMode.source === 'embed') {
      return `${EMBED_PREFIX}${sessionOrMode.agentId ?? 'null'}`;
    }
    // 哨兵会话同样优先于模式/工作区分流：不隔离会混进置顶的「临时工作区」，
    // 且 applyFilter 的四个模式/工作区桶必须同步排除（否则预览/展开条数不一致）。
    if (sessionOrMode.source === 'signal') {
      return SIGNAL_GROUP_KEY;
    }
    return feishuGroupKey(sessionOrMode) ?? dingtalkGroupKey(sessionOrMode) ?? ofMode(sessionOrMode.executionMode, sessionOrMode.workspace);
  }
  return ofMode(sessionOrMode as string | null | undefined, workspace);
}

export function ofMode(executionMode: string | null | undefined, workspace: string | null | undefined): string {
  if (executionMode !== 'CLOUD') {
    return workspace != null && workspace.length > 0 ? `LOCAL:${workspace}` : LOCAL_UNSET;
  }
  if (workspace != null && (workspace.includes('/projects/') || workspace.includes(FEISHU_GROUP_WORKSPACE) || workspace.includes(DINGTALK_GROUP_WORKSPACE))) {
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
  if (key.startsWith(DINGTALK_PRIVATE_GROUP_PREFIX)) {
    return agentName ?? '未知 Agent';
  }
  if (key.startsWith(DINGTALK_GROUP_PREFIX)) {
    return `${agentName ?? '未知 Agent'}:${groupName ?? '钉钉群聊'}`;
  }
  if (CLOUD_TEMP === key) {
    return '临时工作区';
  }
  if (SIGNAL_GROUP_KEY === key) {
    return '信号哨兵';
  }
  if (key.startsWith(EMBED_PREFIX)) {
    return agentName ?? '未知 Agent';
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
  const aEmbed = a.startsWith(EMBED_PREFIX);
  const bEmbed = b.startsWith(EMBED_PREFIX);
  if (aEmbed !== bEmbed) return aEmbed ? -1 : 1;
  const aCloud = a.startsWith('CLOUD:');
  const bCloud = b.startsWith('CLOUD:');
  if (aCloud && !bCloud) return -1;
  if (!aCloud && bCloud) return 1;
  // 信号哨兵分组排最后：所有既有规则之后、localeCompare 之前
  if (a === SIGNAL_GROUP_KEY) return b === SIGNAL_GROUP_KEY ? 0 : 1;
  if (b === SIGNAL_GROUP_KEY) return -1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function applyFilter(groupKey: string | null | undefined): GroupFilterSql {
  if (groupKey == null || groupKey.trim().length === 0) {
    throw new Error('groupKey is required');
  }
  if (isFeishuGroupKey(groupKey)) {
    return applyFeishuFilter(groupKey);
  }
  if (isDingtalkGroupKey(groupKey)) {
    return applyDingtalkFilter(groupKey);
  }
  if (groupKey.startsWith(EMBED_PREFIX)) {
    const agentId = groupKey.slice(EMBED_PREFIX.length);
    if (agentId.length === 0) {
      throw new Error(`Invalid Embed groupKey: ${groupKey}`);
    }
    if (agentId === 'null') {
      return {
        clauses: ['source = ?', 'agent_id IS NULL'],
        params: ['embed'],
      };
    }
    const n = Number(agentId);
    // key 由 of() 生成，任意整数 agentId 都会产出（如 0 → EMBED:0），此处只做格式校验；
    // 按语义范围拒绝会让该桶在「展开更多」分页时报错。
    if (!Number.isInteger(n)) {
      throw new Error(`Invalid Embed groupKey: ${groupKey}`);
    }
    return {
      clauses: ['source = ?', 'agent_id = ?'],
      params: ['embed', n],
    };
  }
  // 哨兵会话桶：of() 优先把 source=signal 分流到 SIGNAL（与工作区/Agent 无关）。
  if (SIGNAL_GROUP_KEY === groupKey) {
    return {
      clauses: ['source = ?'],
      params: ['signal'],
    };
  }
  // 以下四个「模式 + 工作区」桶必须排除 source=embed 与 source=signal：of() 优先把这两类
  // 会话分流到 EMBED:<agentId> / SIGNAL（与工作区路径无关），不排除会让同一条会话在分组
  // 预览里只出现一次、展开后却多出一条（total 对不上、分页偏移错乱）。
  // CLOUD:临时工作区 桶本就带此排除。字面量 NOT IN 与 testing/sql-where.ts 求值器对齐。
  if (LOCAL_UNSET === groupKey) {
    return {
      clauses: ['execution_mode = ?', '(workspace IS NULL OR workspace = ?)', "(source IS NULL OR source NOT IN ('embed', 'signal'))"],
      params: ['LOCAL', ''],
    };
  }
  if (groupKey.startsWith('LOCAL:')) {
    return {
      clauses: ['execution_mode = ?', 'workspace = ?', "(source IS NULL OR source NOT IN ('embed', 'signal'))"],
      params: ['LOCAL', groupKey.slice(6)],
    };
  }
  if (CLOUD_TEMP === groupKey) {
    return {
      clauses: ['execution_mode = ?', '(workspace IS NULL OR workspace = ? OR (workspace NOT LIKE ? AND workspace NOT LIKE ? AND workspace NOT LIKE ?))', "(source IS NULL OR source NOT IN ('embed', 'signal'))"],
      params: ['CLOUD', '', '%/projects/%', '%/feishu-chat/%', '%/dingtalk-chat/%'],
    };
  }
  if (groupKey.startsWith('CLOUD:')) {
    return {
      clauses: ['execution_mode = ?', 'workspace = ?', "(source IS NULL OR source NOT IN ('embed', 'signal'))"],
      params: ['CLOUD', groupKey.slice(6)],
    };
  }
  throw new Error(`Invalid groupKey: ${groupKey}`);
}

/**
 * 活跃相位唯一口径（isActivePhase / session-vo / dashboard SQL / 分组展开页 ORDER BY 共用）。
 * CANCELLING 是取消流程进行中的活跃相位，漏列会把取消中的会话当空闲排到后面。
 * 新增相位或调整口径时只改这一处，SQL 侧用 ACTIVE_PHASE_SQL_LIST 派生，防再次漂移。
 */
export const ACTIVE_PHASES = ['RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING'] as const;

/** 供 SQL IN (...) 使用：'RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'CANCELLING' */
export const ACTIVE_PHASE_SQL_LIST = ACTIVE_PHASES.map((phase) => `'${phase}'`).join(', ');

export function isActivePhase(phase: string | null | undefined): boolean {
  return phase != null && (ACTIVE_PHASES as readonly string[]).includes(phase);
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
  EMBED_PREFIX,
  SIGNAL_GROUP_KEY,
  of,
  feishuGroupKey,
  isFeishuGroupKey,
  applyFeishuFilter,
  dingtalkGroupKey,
  isDingtalkGroupKey,
  applyDingtalkFilter,
  ofMode,
  formatLabel,
  compareKeys,
  applyFilter,
  isActivePhase,
  compareSessions,
};
