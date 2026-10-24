import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { harnessLog } from '../log.js';
import { channelWorkspaceRoots } from './channel-workspace.js';

/**
 * 容器挂载清单（技术方案 §5.1）：隔离边界即挂载清单。
 * 清单由本类单点生成并校验，调用点（ContainerRegistry）不得自行拼接 docker -v 参数。
 *
 * 路径空间原则（决策 15/16）：容器内绝对路径与宿主机逐字节一致，不做翻译。
 * 唯一例外：每用户 /tmp（{tmpDir}/{userId} -> /tmp，持久化），见 purpose='tmp'。
 */
export interface ContainerMount {
  hostPath: string;
  containerPath: string;
  mode: 'rw' | 'ro';
  purpose: string;
  /**
   * 会话工作区附加挂载（飞书/钉钉通道会话，N-2）：rw 项里唯一豁免"必须含 /{userId}/ 段"
   * 规则的条目。豁免的安全性由两侧共同保证：本类校验路径位于通道工作区根下、为
   * {account}/{leaf} 两级以上（挂整个通道根或账号目录一律拒绝）且 leaf 归属本人
   * （私聊工作区 private-{userId} / p2p-{userId} 必须与容器 userId 一致），调用方
   * 只传入经数据库按 user_id 过滤的该用户自己的会话工作区。群聊工作区由同群多个
   * 用户的会话按设计共享，挂进各自容器不构成跨用户泄漏。
   */
  sessionWorkspace?: boolean;
}

export interface MountPlannerRoots {
  userHomeDir: string;
  runtimeDir: string;
  workspaceRoot: string;
  depsDir: string;
  userSkillsDir: string;
  channelDir: string;
  /** 只读项：后端 dist（runtime agent 代码）。 */
  distDir: string;
  /** rw 项：平台共享技能目录（按产品要求容器内可写）。 */
  skillsDir: string;
  /** rw 项：图片产物上传根（FILE_UPLOAD_DIR），按用户挂 {uploadDir}/{userId}。 */
  uploadDir: string;
  /** rw 项：每用户 /tmp 持久根，{tmpDir}/{userId} 映射到容器 /tmp。 */
  tmpDir: string;
  /** rw 项：公共共享目录（管理员投放 + Agent 团队经验库 agent-experience/，容器内路径与宿主机一致）。 */
  shareDir: string;
}

export class MountPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MountPlanError';
  }
}

/** 挂载清单指纹：purpose + 宿主机/容器内路径 + 模式，排序后取 sha256 前 16 位。 */
function fingerprintOfMounts(mounts: readonly ContainerMount[]): string {
  const serialized = mounts
    .map((m) => `${m.purpose}|${m.hostPath}|${m.containerPath}|${m.mode}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(serialized).digest('hex').slice(0, 16);
}

export class ContainerMountPlanner {
  constructor(private readonly roots: MountPlannerRoots) {}

  /**
   * 生成 userId 的挂载清单。生成后立即 assertSafe，任何不合法条目直接抛错
   * （宁可启动失败也不把越界挂载带进容器）。
   *
   * extraWorkspaces：该用户通道会话（飞书/钉钉）的工作区绝对路径，越出每用户根、
   * 但属该用户自己的会话（调用方按数据库 user_id 过滤后传入；私聊叶子另在
   * planSessionWorkspace 内做本人校验）。web 会话工作区在 {workspaceRoot}/{userId}
   * 之下已被覆盖，无需传入。
   */
  plan(userId: number, extraWorkspaces: readonly string[] = []): ContainerMount[] {
    const u = String(userId);
    this.assertShareDirIndependent();
    const mounts: ContainerMount[] = [
      { hostPath: this.under(this.roots.userHomeDir, u), containerPath: this.under(this.roots.userHomeDir, u), mode: 'rw', purpose: 'userHome' },
      { hostPath: this.under(this.roots.workspaceRoot, u), containerPath: this.under(this.roots.workspaceRoot, u), mode: 'rw', purpose: 'workspace' },
      { hostPath: this.under(this.roots.runtimeDir, u), containerPath: this.under(this.roots.runtimeDir, u), mode: 'rw', purpose: 'runtime' },
      { hostPath: this.under(this.roots.depsDir, u), containerPath: this.under(this.roots.depsDir, u), mode: 'rw', purpose: 'deps' },
      { hostPath: this.under(this.roots.channelDir, u), containerPath: this.under(this.roots.channelDir, u), mode: 'rw', purpose: 'channel' },
      { hostPath: this.under(this.roots.userSkillsDir, u), containerPath: this.under(this.roots.userSkillsDir, u), mode: 'rw', purpose: 'userSkills' },
      { hostPath: this.under(this.roots.uploadDir, u), containerPath: this.under(this.roots.uploadDir, u), mode: 'rw', purpose: 'uploads' },
      // 每用户 /tmp 持久化：宿主 {tmpDir}/{userId} 映射到容器 /tmp（路径映射的唯一例外），
      // 跨 stop/重建保留；3077 语义由 assertSafe 统一 chmod 1777。
      { hostPath: this.under(this.roots.tmpDir, u), containerPath: '/tmp', mode: 'rw', purpose: 'tmp' },
      { hostPath: this.under(this.roots.distDir, ''), containerPath: this.under(this.roots.distDir, ''), mode: 'ro', purpose: 'dist' },
      // 公共共享目录（容器内路径与宿主机一致，决策 15）：Agent 团队经验库
      // （agent-experience/ 子目录）由 Agent 会话读写沉淀（技术方案 2026-10-24 D10），
      // 整根 rw；管理员投放内容的防误删从 ro 挂载退化为信任 + 快照兜底。
      // 注意 mode 参与挂载指纹：ro→rw 变更会触发存量容器自动重建。
      { hostPath: this.under(this.roots.shareDir, ''), containerPath: this.under(this.roots.shareDir, ''), mode: 'rw', purpose: 'share' },
      // 平台技能：全局可写（产品要求，容器内可安装/更新共享技能）。
      // 注意这是全员共享目录，容器内 root 可修改会影响其他用户加载的技能，
      // 个人技能仍写 userSkillsDir/{userId}。
      { hostPath: this.under(this.roots.skillsDir, ''), containerPath: this.under(this.roots.skillsDir, ''), mode: 'rw', purpose: 'skills' },
    ];
    for (const workspace of extraWorkspaces) {
      const mount = this.planSessionWorkspace(workspace, userId);
      // null = 每用户工作区根之下，标准清单已覆盖；重复传入只挂一份
      if (!mount || mounts.some((m) => m.hostPath === mount.hostPath)) continue;
      mounts.push(mount);
    }
    this.assertSafe(mounts, userId);
    return mounts;
  }

  /**
   * shareDir 独立性校验（共享目录方案 §4.1 等式盲区）：shareDir 若等于某个按用户
   * 收窄的登记根、或位于其下（如误配为 workspaceRoot 自身或 {workspaceRoot}/7），
   * 现有 assertSafe 规则全部放行——这些根按 {root}/{userId} 挂载，容器路径不重复；
   * 父目录防护对等式 continue 跳过——整棵每用户数据会以 ro 挂进所有容器，构成跨用户
   * 可读。放在 plan() 而非构造器：host 模式不起容器，不应因误配在启动时炸掉。
   */
  private assertShareDirIndependent(): void {
    const share = path.resolve(this.roots.shareDir);
    const perUserRoots = [
      this.roots.workspaceRoot, this.roots.runtimeDir, this.roots.userHomeDir,
      this.roots.userSkillsDir, this.roots.uploadDir, this.roots.channelDir,
      this.roots.depsDir, this.roots.tmpDir,
    ].map((r) => path.resolve(r));
    for (const root of perUserRoots) {
      if (share === root || share.startsWith(root + path.sep)) {
        throw new MountPlanError(`shareDir ${share} must not be or under per-user data root ${root}`);
      }
    }
  }

  /**
   * 通道会话工作区附加挂载的结构校验（N-2）：
   * - 每用户工作区根之下 → 返回 null（标准清单已覆盖，无需附加）；
   * - 必须位于通道工作区根（{workspaceRoot}/feishu-chat|dingtalk-chat）之下，
   *   且为 {account}/{leaf} 两级以上——挂整个通道根或账号目录会把其他用户的
   *   私聊工作区一起带进容器，一律拒绝；
   * - rw、容器内路径与宿主机一致（决策 15）；
   * - 符号链接逃逸防护与目录创建由 assertSafe 统一完成。
   */
  private planSessionWorkspace(workspace: string, userId: number): ContainerMount | null {
    const host = path.resolve(workspace);
    const userWorkspace = this.under(this.roots.workspaceRoot, String(userId));
    if (host === userWorkspace || host.startsWith(userWorkspace + path.sep)) return null;
    const channelRoots = channelWorkspaceRoots(this.roots.workspaceRoot);
    const owning = channelRoots.find((root) => host === root || host.startsWith(root + path.sep));
    if (!owning) {
      throw new MountPlanError(`mount sessionWorkspace: host path ${host} is not under any channel workspace root`);
    }
    const rel = path.relative(owning, host);
    const segments = rel.split(path.sep);
    if (segments.length < 2) {
      throw new MountPlanError(`mount sessionWorkspace: ${host} must be a concrete {account}/{leaf} workspace under ${owning}`);
    }
    // 归属校验（N-5，纵深防御）：私聊工作区只允许挂进本人容器——飞书 private-{userId}、
    // 钉钉 p2p-{userId}。session.workspace 是用户可控字段（建会话 API 原样落库），缺少
    // 这道校验时可把其他用户的飞书/钉钉私聊工作区以 rw 挂进本人容器。群聊工作区
    // （leaf 为 chatId / conversationId）按设计由同群多用户会话共享，不在此判定；
    // 用户自建会话的通道工作区入口已在建会话侧按归属收口（session.routes.ts），
    // 这里是不依赖上游永远正确的第二道
    const privateLeaf = /^(?:private|p2p)-(\d+)$/.exec(segments[1]!);
    if (privateLeaf && privateLeaf[1] !== String(userId)) {
      throw new MountPlanError(
        `mount sessionWorkspace: private workspace ${segments[1]} does not belong to user ${userId}: ${host}`,
      );
    }
    return { hostPath: host, containerPath: host, mode: 'rw', purpose: 'sessionWorkspace', sessionWorkspace: true };
  }

  /**
   * 校验规则（技术方案 §5.1）：
   * - 每条源路径必须位于已登记数据根之下（或 ro 项等于其根自身）；
   * - rw 项的源路径必须以 /{userId} 结尾或包含 /{userId}/ 段，拒绝任何上级目录；
   *   唯一例外是平台技能根（purpose=skills，按产品要求全局可写）；
   * - dist 只读，不得被覆写为 rw；
   * - 源路径不得是另一个已登记数据根的父目录（如挂 /opt/mao-data 整体）；
   * - 符号链接源路径 realpath 后仍必须在登记根内（防链接逃逸）；
   * - 同一容器内路径不得重复挂载。
   */
  assertSafe(mounts: ContainerMount[], userId: number): void {
    const u = String(userId);
    const registeredRoots = [
      this.roots.userHomeDir, this.roots.runtimeDir, this.roots.workspaceRoot,
      this.roots.depsDir, this.roots.userSkillsDir, this.roots.channelDir,
      this.roots.distDir, this.roots.skillsDir, this.roots.uploadDir, this.roots.tmpDir,
      this.roots.shareDir,
    ].map((r) => path.resolve(r));

    const seenContainerPaths = new Set<string>();
    for (const mount of mounts) {
      const host = path.resolve(mount.hostPath);
      // 唯一允许容器路径与宿主机路径不同的挂载：每用户 /tmp（{tmpDir}/{userId} -> /tmp）。
      // 其余条目仍必须逐字节一致（决策 15）。
      const isUserTmpMount = mount.purpose === 'tmp'
        && mount.containerPath === '/tmp'
        && host === path.join(path.resolve(this.roots.tmpDir), u);
      if (mount.containerPath !== host && !isUserTmpMount) {
        // 路径空间一致性：容器内路径必须与宿主机逐字节一致（决策 15）
        throw new MountPlanError(`mount ${mount.purpose}: container path must equal host path (${mount.containerPath} != ${host})`);
      }
      if (mount.mode !== 'ro' && mount.mode !== 'rw') {
        throw new MountPlanError(`mount ${mount.purpose}: invalid mount mode '${String(mount.mode)}'`);
      }
      const ro = mount.mode === 'ro';
      // 登记根校验：源路径必须等于某个登记根（仅 ro 项允许）或位于其下
      const owningRoot = registeredRoots.find((root) => host === root || host.startsWith(root + path.sep));
      if (!owningRoot) {
        throw new MountPlanError(`mount ${mount.purpose}: host path ${host} is not under any registered data root`);
      }
      if (!ro && !mount.sessionWorkspace) {
        // 平台技能根是共享 rw 例外之一（产品要求容器内可安装/更新共享技能），
        // 且必须恰为登记的 skillsDir 根，不能借 purpose 放宽到其它共享路径。
        const isPlatformSkillsRoot = mount.purpose === 'skills' && host === path.resolve(this.roots.skillsDir);
        // 共享目录整根 rw 例外（团队经验库方案 2026-10-24 D10）：agent-experience/ 经验库
        // 需容器内写入；同样必须恰为登记的 shareDir 根，防借 purpose 扩大到子路径外。
        const isSharedShareRoot = mount.purpose === 'share' && host === path.resolve(this.roots.shareDir);
        // rw 项必须含 userId 尾段/中间段，拒绝把整个数据根或上级挂进容器。
        // 通道会话工作区（sessionWorkspace）按 {account}/{leaf} 结构性豁免 + 私聊
        // 叶子归属校验（planSessionWorkspace），并由调用方按数据库 user_id 过滤保证
        if (!isPlatformSkillsRoot && !isSharedShareRoot) {
          const rel = path.relative(owningRoot, host);
          if (!this.containsUserSegment(rel, u)) {
            throw new MountPlanError(`mount ${mount.purpose}: rw path ${host} must contain /${u}/ segment (got relative '${rel}')`);
          }
        }
      }
      // 父目录防护：不得挂任何登记根的父目录（含 /opt/mao 与 /opt/mao-data 互为父子的场景）。
      // 用 path.relative 包含判定而非 startsWith(host + sep)：host='/' 时后者拼出
      // '//' 永不匹配，整棵宿主文件系统会被 ro 挂进所有容器（round-02 review Bug 2）。
      for (const root of registeredRoots) {
        if (root === host) continue;
        const rel = path.relative(host, root);
        if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
          throw new MountPlanError(`mount ${mount.purpose}: ${host} is a parent of registered root ${root}`);
        }
      }
      // 符号链接逃逸：realpath 后必须仍在该条目声称的登记根之下
      if (existsSync(host)) {
        if (lstatSync(host).isSymbolicLink()) {
          const real = realpathSync(host);
          if (!real.startsWith(owningRoot + path.sep) && real !== owningRoot) {
            throw new MountPlanError(`mount ${mount.purpose}: symlink ${host} -> ${real} escapes registered root ${owningRoot}`);
          }
        }
      } else if (mount.mode === 'rw') {
        // rw 目录必须存在（容器启动前由宿主机创建）
        try { mkdirSync(host, { recursive: true }); } catch (e) {
          throw new MountPlanError(`mount ${mount.purpose}: cannot create host dir ${host}: ${(e as Error).message}`);
        }
      }
      // 容器内 /tmp 的 sticky 语义：宿主机目录统一 1777（root 可写、普通用户互删受限）
      if (mount.purpose === 'tmp' && existsSync(host) && !lstatSync(host).isSymbolicLink()) {
        try { chmodSync(host, 0o1777); } catch (e) {
          throw new MountPlanError(`mount tmp: cannot chmod 1777 ${host}: ${(e as Error).message}`);
        }
      }
      if (seenContainerPaths.has(mount.containerPath)) {
        throw new MountPlanError(`mount ${mount.purpose}: duplicate container path ${mount.containerPath}`);
      }
      seenContainerPaths.add(mount.containerPath);
    }
  }

  /** 生成 docker -v 参数（assertSafe 通过后调用）。 */
  toDockerArgs(mounts: ContainerMount[]): string[] {
    const args: string[] = [];
    for (const m of mounts) {
      args.push('--volume', `${m.hostPath}:${m.containerPath}:${m.mode === 'ro' ? 'ro' : 'rw'}`);
    }
    return args;
  }

  /**
   * 标准挂载计划（不含动态会话工作区）的指纹。容器挂载清单在 docker run 时定型，
   * `docker start` 复用创建时的清单：planner 变更（如新增 uploads 挂载）不会让既有
   * 容器重建，上线后老容器会一直缺新挂载。指纹供 ContainerRegistry 在 ensureRunning
   * 时比对，漂移即回收重建（一次性代价，见 container-registry ensureRunningLocked）。
   */
  standardMountsFingerprint(userId: number): string {
    return this.fingerprintOf(this.plan(userId).filter((m) => !m.sessionWorkspace));
  }

  /** 给定挂载子集的指纹（createAndStart 复用同一次 plan 的结果，避免二次规划）。 */
  fingerprintOf(mounts: readonly ContainerMount[]): string {
    return fingerprintOfMounts(mounts);
  }

  /** 挂载清单审计日志（userId + 完整挂载表）。 */
  auditLog(userId: number, mounts: ContainerMount[]): void {
    for (const m of mounts) {
      harnessLog('info', `[container-mount] user=${userId} ${m.purpose}: ${m.hostPath} -> ${m.containerPath} (${m.mode})`);
    }
  }

  private containsUserSegment(rel: string, u: string): boolean {
    if (rel === u) return true;
    const parts = rel.split(path.sep);
    return parts.includes(u);
  }

  private under(root: string, leaf: string): string {
    return leaf === '' ? path.resolve(root) : path.join(path.resolve(root), leaf);
  }
}
