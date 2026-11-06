import path from 'node:path';
import type { SessionVO } from '../rest/types';
import { isWorkspaceWithin } from '../local/sandbox';

/** `/resume` 面板默认展示的会话条数上限（真实账号活跃会话可达数百条，必须截断）。 */
export const RESUME_PICK_LIMIT = 20;

export interface SwitchableSessionsFilter {
  /** 当前会话 id：不出现在可切换列表里（目标=当前由调用方单独提示）。 */
  currentId?: number;
  /** 进程是否为 LOCAL 模式（只列同模式会话，跨模式需另开进程）。 */
  localMode: boolean;
  /** LOCAL 进程的启动工作区：目标会话 workspace 必须等于它或在其内部。 */
  localWorkspace: string;
  /** 截断条数，默认 RESUME_PICK_LIMIT。 */
  limit?: number;
}

/** LOCAL 会话的 workspace 是否落在启动工作区内（与 LocalExecutor 的信任边界一致）。 */
export function isLocalWorkspaceAllowed(workspace: string | null | undefined, localWorkspace: string): boolean {
  if (!workspace || workspace.trim() === '') return false;
  return isWorkspaceWithin(path.resolve(workspace), localWorkspace);
}

/** 最近更新优先：与 `mao-agent ls` / pickLatestSession 同口径（updatedAt DESC, id DESC）。 */
export function compareSessionsByRecent(a: SessionVO, b: SessionVO): number {
  const ta = Date.parse(a.updatedAt ?? '') || 0;
  const tb = Date.parse(b.updatedAt ?? '') || 0;
  if (tb !== ta) return tb - ta;
  return (b.id ?? 0) - (a.id ?? 0);
}

/**
 * 会话列表 → 当前进程内可切换的会话：
 * - 排除当前会话；
 * - 只保留与进程执行模式一致的会话（LOCAL 进程只切 LOCAL，反之亦然）；
 * - LOCAL 会话的 workspace 必须落在启动工作区内；
 * - 按最近更新排序并截断（默认 RESUME_PICK_LIMIT 条）。
 */
export function filterSwitchableSessions(all: SessionVO[], opts: SwitchableSessionsFilter): SessionVO[] {
  const { currentId, localMode, localWorkspace, limit = RESUME_PICK_LIMIT } = opts;
  return all
    .filter((s) => s.id != null && s.id !== currentId)
    .filter((s) => (s.executionMode === 'LOCAL') === localMode)
    .filter((s) => s.executionMode !== 'LOCAL' || isLocalWorkspaceAllowed(s.workspace, localWorkspace))
    .sort(compareSessionsByRecent)
    .slice(0, limit);
}
