import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { lstat, readdir, rm } from 'node:fs/promises';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { SessionRepository } from '../session/session.repository.js';

export type WorkspaceKind = 'temp' | 'project' | 'other';
export type SizeState = 'ready' | 'pending' | 'timeout' | 'failed';

/** 大小统计条目上限：超过即停（标 timeout），防深目录打爆磁盘 IO（技术方案 2026-10-29 §2.1-2）。 */
const WALK_MAX_DEPTH = 24;
const WALK_MAX_ENTRIES = 200_000;
const WALK_TIMEOUT_MS = 30_000;
/** 目录间并发（技术方案 §2.1-2）。 */
const SIZE_CONCURRENCY = 4;
const SIZE_TTL_MS = 10 * 60 * 1000;

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

interface SizeCacheValue {
  bytes: number;
  state: 'ready' | 'timeout' | 'failed';
  at: number;
}

/** 路径校验 / 大小统计 / 删除的总览服务（技术方案 2026-10-29 §4.1-1）。 */
export class WorkspaceOverviewService {
  /** key = `${userId}:${path}`；仅缓存终态（ready/timeout/failed），pending 由 in-flight Promise 表达。 */
  private readonly sizeCache = new Map<string, SizeCacheValue>();
  private readonly sizeInFlight = new Map<string, Promise<void>>();
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

  /** 枚举本人根下一级目录（projects/ 展开其子目录），合并大小缓存与会话聚合成资产视图。 */
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
    // 首屏未命中缓存的目录触发后台计算，队列按最近使用降序（D11：优先填用户正看到的行）
    this.scheduleSizeCompute(userId, entries);
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
    const cached = this.sizeCache.get(`${userId}:${path}`);
    const fresh = cached != null && Date.now() - cached.at < SIZE_TTL_MS;
    return {
      name,
      path,
      kind,
      isGit: existsSync(join(path, '.git')),
      sizeBytes: fresh ? cached!.bytes : null,
      sizeState: fresh ? cached!.state : 'pending',
      activeSessions,
      archivedSessions,
      lastUsedAt,
    };
  }

  /** 未命中新鲜缓存的目录进入后台计算队列；同一目录的重复触发被 in-flight 表去重。 */
  scheduleSizeCompute(userId: number, entries: WorkspaceOverviewEntry[]): void {
    const now = Date.now();
    const todo = entries
      .filter(e => {
        const key = `${userId}:${e.path}`;
        const cached = this.sizeCache.get(key);
        // 过期（TTL 外）的旧值也视为未命中：只展示 pending 直到重算完成
        return (cached == null || now - cached.at >= SIZE_TTL_MS) && !this.sizeInFlight.has(key);
      })
      // 按最近使用降序入队（D11），未使用过的排最后
      .sort((a, b) => (b.lastUsedAt ?? '').localeCompare(a.lastUsedAt ?? ''))
      .map(e => e.path);
    void this.runSizeQueue(userId, todo);
  }

  private async runSizeQueue(userId: number, paths: string[]): Promise<void> {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(SIZE_CONCURRENCY, paths.length) }, async () => {
      while (cursor < paths.length) {
        const path = paths[cursor++]!;
        const key = `${userId}:${path}`;
        // 只跳过「新鲜」缓存与在途任务：TTL 外的旧值仍在 Map 里，若按「有缓存即跳过」
        // 判重，scheduleSizeCompute 送入的过期条目会被全部跳过，大小列永久停在 pending
        const cached = this.sizeCache.get(key);
        const fresh = cached != null && Date.now() - cached.at < SIZE_TTL_MS;
        if (fresh || this.sizeInFlight.has(key)) continue;
        const task = this.computeSize(path)
          .then(result => {
            this.sizeCache.set(key, { ...result, at: Date.now() });
          })
          .catch((e) => {
            console.warn(`[workspace-overview] size walk failed ${path}:`, e);
            this.sizeCache.set(key, { bytes: 0, state: 'failed', at: Date.now() });
          })
          .finally(() => {
            this.sizeInFlight.delete(key);
          });
        this.sizeInFlight.set(key, task);
        await task;
      }
    });
    await Promise.all(workers);
  }

  /** 单目录 walk：深度 / 条目 / 超时三重上限，符号链接 lstat 识别后跳过（永不跟随）。 */
  private async computeSize(path: string): Promise<{ bytes: number; state: 'ready' | 'timeout' | 'failed' }> {
    const deadline = Date.now() + WALK_TIMEOUT_MS;
    let entries = 0;
    let timedOut = false;

    const walk = async (dir: string, depth: number): Promise<number> => {
      if (depth > WALK_MAX_DEPTH || Date.now() > deadline) {
        timedOut = true;
        return 0;
      }
      let dirBytes = 0;
      const children = await readdir(dir, { withFileTypes: true });
      for (const child of children) {
        if (++entries > WALK_MAX_ENTRIES) {
          timedOut = true;
          break;
        }
        if (child.isSymbolicLink()) continue;
        const full = join(dir, child.name);
        if (child.isDirectory()) {
          dirBytes += await walk(full, depth + 1);
        } else if (child.isFile()) {
          // symlink 已跳过；其余非目录非普通文件（fifo 等）不计
          const st = await lstat(full).catch(() => null);
          if (st?.isFile()) dirBytes += st.size;
        }
        if (timedOut) break;
      }
      return dirBytes;
    };

    try {
      const st = await lstat(path).catch(() => null);
      if (st == null || !st.isDirectory()) {
        return { bytes: 0, state: 'failed' };
      }
      const bytes = await walk(path, 1);
      return timedOut ? { bytes, state: 'timeout' } : { bytes, state: 'ready' };
    } catch (e) {
      console.warn(`[workspace-overview] walk error ${path}:`, e);
      return { bytes: 0, state: 'failed' };
    }
  }

  /** 失效缓存并后台重算（顶部「刷新」/ 行内刷新）：立即返回，客户端按 pending → 3s 重查感知结果。 */
  async refresh(userId: number, path?: string | null): Promise<void> {
    if (path != null) {
      // 单目录刷新同样受本人根 scope 约束：否则任意登录用户可借此遍历服务器上
      // 任意目录（大小结果不进总览响应，但磁盘 IO 与超时负担是真实的）
      const scoped = this.resolveWithinUserRoot(userId, path);
      if ('error' in scoped) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, scoped.message);
      }
      const target = scoped.path;
      this.sizeCache.delete(`${userId}:${target}`);
      void this.runSizeQueue(userId, [target]);
      return;
    }
    for (const key of [...this.sizeCache.keys()]) {
      if (key.startsWith(`${userId}:`)) this.sizeCache.delete(key);
    }
    // listOverview 自身会对全部未命中目录触发后台计算
    await this.listOverview(userId);
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

  /** 物理删除（D6：recursive + force:false，进程内 per-path 互斥），完成后失效大小缓存。 */
  async deleteWorkspace(userId: number, resolvedPath: string): Promise<void> {
    if (this.deleting.has(resolvedPath)) {
      throw new Error('该目录正在删除中');
    }
    this.deleting.add(resolvedPath);
    try {
      await rm(resolvedPath, { recursive: true, force: false });
      this.sizeCache.delete(`${userId}:${resolvedPath}`);
    } catch (e) {
      // 校验与删除间目录已被移除（并发 / 重复点击重试）：视为已删除，不报错
      if ((e as { code?: string }).code === 'ENOENT') return;
      throw e;
    } finally {
      this.deleting.delete(resolvedPath);
    }
  }
}
