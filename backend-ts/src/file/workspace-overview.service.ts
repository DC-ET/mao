import { existsSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { rm } from 'node:fs/promises';
import type { WorkspaceChannel, WorkspaceChatType, WorkspaceKind } from '@mao/contracts';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { channelWorkspaceRoots, parseChannelWorkspace } from '../harness/container/channel-workspace.js';
import type { SessionRepository } from '../session/session.repository.js';

export type { WorkspaceKind } from '@mao/contracts';
/** 大小不再统计。字段保留给旧客户端：恒为 ready + null，避免它们把 pending 当成还要轮询。 */
export type SizeState = 'ready' | 'pending' | 'timeout' | 'failed';

/** 通道工作区条目的通道标识（随 WorkspaceOverviewEntry 下发，前端据此汉化与门控删除）。 */
interface ChannelEntryRef {
  channel: WorkspaceChannel;
  chatType: WorkspaceChatType;
  accountId: string;
}

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
  /** 机器人通道类型（kind === 'channel' 时存在）：飞书 / 钉钉。 */
  channel?: WorkspaceChannel;
  /** 通道会话类型（kind === 'channel' 时存在）：群聊（多人共享）/ 私聊（本人）。 */
  chatType?: WorkspaceChatType;
  /** 机器人账号 id（kind === 'channel' 时存在）：飞书 app_id / 钉钉 botId。 */
  accountId?: string;
}

export interface WorkspaceReference {
  id: number;
  title: string | null;
  phase: string | null;
}

export type WorkspacePathError = 'out-of-scope' | 'container' | 'missing' | 'shared';

/** 路径校验与删除的总览服务。目录大小不再统计。 */
export class WorkspaceOverviewService {
  /** per-path 删除互斥（防双击并发删，D6）。 */
  private readonly deleting = new Set<string>();

  constructor(
    private readonly pathSandbox: { getWorkspaceRoot(): string },
    private readonly sessionRepo: Pick<
      SessionRepository,
      | 'aggregateWorkspaceUsage'
      | 'aggregateWorkspaceUsageAnyUser'
      | 'listActiveWorkspaceReferences'
      | 'listWorkspacesByUser'
      | 'existsSessionUnderWorkspace'
    >,
  ) {}

  userRoot(userId: number): string {
    return resolve(this.pathSandbox.getWorkspaceRoot(), String(userId));
  }

  /**
   * 枚举本人根下一级目录（projects/ 展开其子目录）+ 受管机器人通道工作区，
   * 合并会话聚合成资产视图。不遍历目录算大小。
   *
   * 通道工作区（技术方案 2026-11-02）：位于全局根 {workspaceRoot}/feishu-chat|dingtalk-chat/
   * {accountId}/{leaf}，不在每用户根内。收录口径：
   * - 私聊 leaf（private-{userId} / p2p-{userId}）：只列本人的；
   * - 群聊 leaf（chatId / conversationId）：只列本人有会话（含归档）参与过的——
   *   群目录由同群多用户按设计共享，参与性是「与我有关」的判定；
   * - 群目录的会话计数跨用户聚合（共享目录按 user_id 过滤会少计）。
   */
  async listOverview(userId: number): Promise<{ entries: WorkspaceOverviewEntry[]; error: string | null }> {
    const userRoot = this.userRoot(userId);
    const entries: WorkspaceOverviewEntry[] = [];
    if (existsSync(userRoot)) {
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
            entries.push(this.buildEntry(join(projectsDir, child.name), child.name, 'project', null, usage));
          }
          continue;
        }
        // 数字名 = 会话临时工作区（建会话时以会话 id 自动创建）；其余为历史遗留 / 自定义目录
        const kind: WorkspaceKind = /^\d+$/.test(item.name) ? 'temp' : 'other';
        entries.push(this.buildEntry(join(userRoot, item.name), item.name, kind, null, usage));
      }
    }
    const channelDirs = await this.listManagedChannelDirs(userId);
    if (channelDirs.length > 0) {
      // 群目录按设计多人共享：计数跨用户聚合，按 user_id 过滤会少计同群其他用户的会话
      const channelUsage = await this.sessionRepo.aggregateWorkspaceUsageAnyUser(channelDirs.map(d => d.path));
      for (const dir of channelDirs) {
        entries.push(this.buildEntry(dir.path, dir.leaf, 'channel', dir.ref, channelUsage));
      }
    }
    return { entries, error: null };
  }

  /**
   * 受管通道工作区目录清单：磁盘枚举 {accountId}/{leaf} 二级目录（符号链接/非目录逐级跳过），
   * 按可见性过滤——私聊只留本人 leaf，群聊只留本人有会话参与过的。
   */
  private async listManagedChannelDirs(userId: number): Promise<Array<{ path: string; leaf: string; ref: ChannelEntryRef }>> {
    const workspaceRoot = this.pathSandbox.getWorkspaceRoot();
    const userWorkspaces = new Set(await this.sessionRepo.listWorkspacesByUser(userId));
    const dirs: Array<{ path: string; leaf: string; ref: ChannelEntryRef }> = [];
    for (const channelRoot of channelWorkspaceRoots(workspaceRoot)) {
      if (!existsSync(channelRoot)) continue;
      let accounts: Array<{ name: string; isDirectory: boolean; isSymbolicLink: boolean }>;
      try {
        accounts = readdirSync(channelRoot, { withFileTypes: true }).map(d => ({
          name: d.name,
          isDirectory: d.isDirectory(),
          isSymbolicLink: d.isSymbolicLink(),
        }));
      } catch {
        continue;
      }
      for (const account of accounts) {
        if (account.isSymbolicLink || !account.isDirectory) continue;
        const accountDir = join(channelRoot, account.name);
        let leaves: Array<{ name: string; isDirectory: boolean; isSymbolicLink: boolean }>;
        try {
          leaves = readdirSync(accountDir, { withFileTypes: true }).map(d => ({
            name: d.name,
            isDirectory: d.isDirectory(),
            isSymbolicLink: d.isSymbolicLink(),
          }));
        } catch {
          continue;
        }
        for (const leaf of leaves) {
          if (leaf.isSymbolicLink || !leaf.isDirectory) continue;
          const dir = join(accountDir, leaf.name);
          const ref = parseChannelWorkspace(dir, workspaceRoot);
          if (ref == null) continue;
          if (ref.chatType === 'private' && ref.ownerUserId !== userId) continue;
          if (ref.chatType === 'group' && !this.hasSessionUnder(userWorkspaces, dir)) continue;
          dirs.push({ path: dir, leaf: leaf.name, ref: { channel: ref.channel, chatType: ref.chatType, accountId: ref.accountId } });
        }
      }
    }
    return dirs;
  }

  /** 用户会话工作区集合是否命中目录（精确或位于目录之内），与 SQL 前缀口径一致。 */
  private hasSessionUnder(userWorkspaces: Set<string>, dir: string): boolean {
    for (const workspace of userWorkspaces) {
      if (workspace === dir || workspace.startsWith(dir + sep)) return true;
    }
    return false;
  }

  private buildEntry(
    path: string,
    name: string,
    kind: WorkspaceKind,
    channelRef: ChannelEntryRef | null,
    usage?: Map<string, { total: number; active: number; archived: number; lastUsedAt: string | null }>,
  ): WorkspaceOverviewEntry {
    // 会话关联按目录前缀归并：workspace === 目录，或 workspace 位于目录之内（D4③ 同口径）
    let activeSessions = 0;
    let archivedSessions = 0;
    let lastUsedAt: string | null = null;
    if (usage != null) {
      for (const [workspace, stat] of usage) {
        if (workspace !== path && !workspace.startsWith(path + sep)) continue;
        activeSessions += stat.active;
        archivedSessions += stat.archived;
        if (stat.lastUsedAt != null && (lastUsedAt == null || stat.lastUsedAt > lastUsedAt)) {
          lastUsedAt = stat.lastUsedAt;
        }
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
      ...(channelRef == null ? {} : { channel: channelRef.channel, chatType: channelRef.chatType, accountId: channelRef.accountId }),
    };
  }

  /**
   * 旧客户端的「刷新大小」。不再遍历目录。
   * 带 path 时仍做受管范围校验（不校验存在性，与旧版 refresh 口径一致），
   * 避免把这个入口留成任意路径探针。
   */
  async refresh(userId: number, path?: string | null): Promise<void> {
    if (path == null) return;
    const scoped = await this.resolveScoped(userId, path, { allowSharedGroup: true, requireExists: false });
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
   * 本人根内一级目录或 projects/* 子目录（projects 容器本身硬拒）；或受管通道工作区
   * （技术方案 2026-11-02）——本人私聊可删，群聊目录多人共享一律拒绝（shared）。
   */
  resolveDeletablePath(userId: number, rawPath: string): { path: string } | { error: WorkspacePathError; message: string } {
    const personal = this.resolvePersonalPath(userId, rawPath, true);
    if (!('error' in personal)) return personal;
    const target = resolve(rawPath);
    const ref = parseChannelWorkspace(target, this.pathSandbox.getWorkspaceRoot());
    if (ref == null) return personal;
    if (ref.chatType === 'private') {
      if (ref.ownerUserId !== userId) {
        return { error: 'out-of-scope', message: '只能删除本人的机器人通道工作区' };
      }
      if (!existsSync(target)) return { error: 'missing', message: '目录不存在（可能已被删除）' };
      return { path: target };
    }
    return { error: 'shared', message: '群聊工作区为多人共享，暂不支持删除' };
  }

  /**
   * 受管口径的路径校验（文件管理 / 引用清单共用，技术方案 2026-11-02）：
   * 个人目录规则同删除守卫；通道目录——本人私聊直接放行，群聊需本人有会话参与。
   * 群目录在此放行「管理」（浏览/读写），删除仍走 resolveDeletablePath 的 shared 拒绝。
   */
  async resolveManagedPath(userId: number, rawPath: string): Promise<{ path: string } | { error: WorkspacePathError; message: string }> {
    return this.resolveScoped(userId, rawPath, { allowSharedGroup: true, requireExists: true });
  }

  /** 个人目录 / 受管通道目录的统一解析；requireExists 控制是否校验目录存在。 */
  private async resolveScoped(
    userId: number,
    rawPath: string,
    options: { allowSharedGroup: boolean; requireExists: boolean },
  ): Promise<{ path: string } | { error: WorkspacePathError; message: string }> {
    const personal = this.resolvePersonalPath(userId, rawPath, options.requireExists);
    if (!('error' in personal)) return personal;
    const target = resolve(rawPath);
    const ref = parseChannelWorkspace(target, this.pathSandbox.getWorkspaceRoot());
    if (ref == null) return personal;
    if (ref.chatType === 'private') {
      if (ref.ownerUserId !== userId) {
        return { error: 'out-of-scope', message: '只能操作本人的机器人通道工作区' };
      }
    } else {
      if (!options.allowSharedGroup) {
        return { error: 'shared', message: '群聊工作区为多人共享，暂不支持删除' };
      }
      if (!(await this.sessionRepo.existsSessionUnderWorkspace(userId, target))) {
        return { error: 'out-of-scope', message: '只能操作本人参与过的机器人通道工作区' };
      }
    }
    if (options.requireExists && !existsSync(target)) {
      return { error: 'missing', message: '目录不存在（可能已被删除）' };
    }
    return { path: target };
  }

  /** 个人目录的层级规则：一级目录或 projects/ 一级子目录；projects 容器硬拒。 */
  private resolvePersonalPath(userId: number, rawPath: string, requireExists: boolean): { path: string } | { error: WorkspacePathError; message: string } {
    const scoped = this.resolveWithinUserRoot(userId, rawPath);
    if ('error' in scoped) return { ...scoped, message: '只能操作本人工作区根目录下的目录' };
    const userRoot = this.userRoot(userId);
    const target = scoped.path;
    const rel = relative(userRoot, target);
    if (rel === '' || rel === '.') {
      return { error: 'out-of-scope', message: '不能操作工作区根目录本身' };
    }
    const segments = rel.split(sep);
    if (segments.length === 1 && segments[0] === 'projects') {
      return { error: 'container', message: 'projects 容器目录不可删除，请删除其中的项目目录' };
    }
    const isProjectChild = segments.length === 2 && segments[0] === 'projects' && segments[1] !== '';
    const isTopLevel = segments.length === 1 && segments[0] !== '';
    if (!isTopLevel && !isProjectChild) {
      return { error: 'out-of-scope', message: '只能操作一级目录或 projects 下的一级项目目录' };
    }
    if (requireExists && !existsSync(target)) {
      return { error: 'missing', message: '目录不存在（可能已被删除）' };
    }
    return { path: target };
  }

  /** 目录的进行中引用清单（删除守卫 D4③ 与确认弹层共用）。 */
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
