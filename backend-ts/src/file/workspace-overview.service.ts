import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { rm } from 'node:fs/promises';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { SessionRepository } from '../session/session.repository.js';

export type WorkspaceKind = 'temp' | 'project' | 'other';
/** 大小不再统计。字段保留给旧客户端：恒为 ready + null，避免它们把 pending 当成还要轮询。 */
export type SizeState = 'ready' | 'pending' | 'timeout' | 'failed';

export interface WorkspaceOverviewEntry {
  name: string;
  path: string;
  kind: WorkspaceKind;
  isGit: boolean;
  sizeBytes: number | null;
  sizeState: SizeState;
  activeSessions: number;
  archivedSessions: number;
  lastUsedAt: string | null;
}

export interface WorkspaceReference {
  id: number;
  title: string | null;
  phase: string | null;
}

export type WorkspacePathError = 'out-of-scope' | 'container' | 'missing';

/** 路径校验与删除的总览服务。目录大小不再统计。 */
export class WorkspaceOverviewService {
  /** per-path 删除互斥（防双击并发删，D6）。 */
  private readonly deleting = new Set<string>();

  constructor(
    private readonly pathSandbox: { getWorkspaceRoot(): string },
    private readonly sessionRepo: Pick<
      SessionRepository,
      'aggregateWorkspaceUsage' | 'listActiveWorkspaceReferences'
    >,
  ) {}

  userRoot(userId: number): string {
    return resolve(this.pathSandbox.getWorkspaceRoot(), String(userId));
  }

  /** 枚举本人根下一级目录（projects/ 展开其子目录），合并会话聚合成资产视图。不遍历目录算大小。 */
  async listOverview(userId: number): Promise<{ entries: WorkspaceOverviewEntry[]; error: string | null }> {
    const userRoot = this.userRoot(userId);
    if (!existsSync(userRoot)) {
      return { entries: [], error: null };
    }
    let names: Array<{ name: string; isDirectory: boolean; isSymbolicLink: boolean }>;
    try {
      names = readdirSync(userRoot, { withFileTypes: true }).map(d => ({
        name: d.name,
        isDirectory: d.isDirectory(),
        isSymbolicLink: d.isSymbolicLink(),
      }));
    } catch (e) {
      console.warn(`[workspace-overview] readdir failed userId=${userId}:`, e);
      return { entries: [], error: '读取工作区根目录失败' };
    }
    const usage = await this.sessionRepo.aggregateWorkspaceUsage(userId);
    const entries: WorkspaceOverviewEntry[] = [];
    for (const item of names) {
      // 符号链接一律不跟随也不列出（复用 workspace-browse 同款防御，D4①）
      if (item.isSymbolicLink || !item.isDirectory) continue;
      if (item.name === 'projects') {
        const projectsDir = join(userRoot, 'projects');
        let children: Array<{ name: string; isDirectory: boolean; isSymbolicLink: boolean }>;
        try {
          children = readdirSync(projectsDir, { withFileTypes: true }).map(d => ({
            name: d.name,
            isDirectory: d.isDirectory(),
            isSymbolicLink: d.isSymbolicLink(),
          }));
        } catch {
          continue;
        }
        for (const child of children) {
          if (child.isSymbolicLink || !child.isDirectory) continue;
          entries.push(this.buildEntry(userId, join(projectsDir, child.name), child.name, 'project', usage));
        }
        continue;
      }
      // 数字名 = 会话临时工作区（建会话时以会话 id 自动创建）；其余为历史遗留 / 自定义目录
      const kind: WorkspaceKind = /^\d+$/.test(item.name) ? 'temp' : 'other';
      entries.push(this.buildEntry(userId, join(userRoot, item.name), item.name, kind, usage));
    }
    return { entries, error: null };
  }

  private buildEntry(
    userId: number,
    path: string,
    name: string,
    kind: WorkspaceKind,
    usage: Map<string, { total: number; active: number; archived: number; lastUsedAt: string | null }>,
  ): WorkspaceOverviewEntry {
    // 会话关联按目录前缀归并：workspace === 目录，或 workspace 位于目录之内（D4③ 同口径）
    let activeSessions = 0;
    let archivedSessions = 0;
    let lastUsedAt: string | null = null;
    for (const [workspace, stat] of usage) {
      if (workspace !== path && !workspace.startsWith(path + sep)) continue;
      activeSessions += stat.active;
      archivedSessions += stat.archived;
      if (stat.lastUsedAt != null && (lastUsedAt == null || stat.lastUsedAt > lastUsedAt)) {
        lastUsedAt = stat.lastUsedAt;
      }
    }
    return {
      name,
      path,
      kind,
      isGit: existsSync(join(path, '.git')),
      sizeBytes: null,
      sizeState: 'ready',
      activeSessions,
      archivedSessions,
      lastUsedAt,
    };
  }

  /**
   * 旧客户端的「刷新大小」。不再遍历目录。
   * 带 path 时仍做本人根校验，避免把这个入口留成任意路径探针。
   */
  async refresh(userId: number, path?: string | null): Promise<void> {
    if (path == null) return;
    const scoped = this.resolveWithinUserRoot(userId, path);
    if ('error' in scoped) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, scoped.message);
    }
  }

  /**
   * 解析并校验路径严格位于本人根内（删除守卫与单目录刷新共用的越界防线，D4①②）：
   * 只做 scope 判断，不判断目录形态与存在性。
   */
  private resolveWithinUserRoot(userId: number, rawPath: string): { path: string } | { error: 'out-of-scope'; message: string } {
    const userRoot = this.userRoot(userId);
    const target = resolve(rawPath);
    if (target !== userRoot && !target.startsWith(userRoot + sep)) {
      return { error: 'out-of-scope', message: '只能操作本人工作区根目录下的目录' };
    }
    return { path: target };
  }

  /**
   * 删除守卫的路径校验（D4①②，不抛异常、由路由映射 400）：
   * 解析后严格位于本人根内，且为一级目录或 projects/ 的一级子目录；projects 容器本身硬拒。
   */
  resolveDeletablePath(userId: number, rawPath: string): { path: string } | { error: WorkspacePathError; message: string } {
    const scoped = this.resolveWithinUserRoot(userId, rawPath);
    if ('error' in scoped) return { ...scoped, message: '只能删除本人工作区根目录下的目录' };
    const userRoot = this.userRoot(userId);
    const target = scoped.path;
    const rel = relative(userRoot, target);
    if (rel === '' || rel === '.') {
      return { error: 'out-of-scope', message: '不能删除工作区根目录本身' };
    }
    const segments = rel.split(sep);
    if (segments.length === 1 && segments[0] === 'projects') {
      return { error: 'container', message: 'projects 容器目录不可删除，请删除其中的项目目录' };
    }
    const isProjectChild = segments.length === 2 && segments[0] === 'projects' && segments[1] !== '';
    const isTopLevel = segments.length === 1 && segments[0] !== '';
    if (!isTopLevel && !isProjectChild) {
      return { error: 'out-of-scope', message: '只能删除一级目录或 projects 下的一级项目目录' };
    }
    if (!existsSync(target)) {
      return { error: 'missing', message: '目录不存在（可能已被删除）' };
    }
    return { path: target };
  }

  /** 目录的进行中引用（活跃相位会话），删除守卫 D4③ 与确认弹层共用。 */
  async listActiveReferences(userId: number, resolvedPath: string): Promise<WorkspaceReference[]> {
    return this.sessionRepo.listActiveWorkspaceReferences(userId, resolvedPath);
  }

  /** 物理删除（D6：recursive + force:false，进程内 per-path 互斥）。 */
  async deleteWorkspace(_userId: number, resolvedPath: string): Promise<void> {
    if (this.deleting.has(resolvedPath)) {
      throw new Error('该目录正在删除中');
    }
    this.deleting.add(resolvedPath);
    try {
      await rm(resolvedPath, { recursive: true, force: false });
    } catch (e) {
      // 校验与删除间目录已被移除（并发 / 重复点击重试）：视为已删除，不报错
      if ((e as { code?: string }).code === 'ENOENT') return;
      throw e;
    } finally {
      this.deleting.delete(resolvedPath);
    }
  }
}
