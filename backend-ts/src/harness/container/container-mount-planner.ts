import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { harnessLog } from '../log.js';
import { channelWorkspaceRoots, parseChannelWorkspace } from './channel-workspace.js';

/**
 * 容器挂载清单（技术方案 §5.1；2026-11-07 起容器键为 (userId, agentId) 复合维度）：
 * 隔离边界即挂载清单。清单由本类单点生成并校验，调用点（ContainerRegistry）不得自行拼接 docker -v 参数。
 *
 * 路径空间原则（决策 15/16）：容器内绝对路径与宿主机逐字节一致，不做翻译。
 * 唯一例外：每用户 /tmp（{tmpDir}/{userId} -> /tmp，持久化），见 purpose='tmp'。
 *
 * Agent 维度（2026-11-07）：skillViews / channel 两条按 {root}/{userId}/{agentId} 收窄——
 * 容器内可见的技能视图 = 当前 (user, agent) 的技能，其他 Agent 的技能视图在容器文件系统
 * 层面不存在。share 维持整根 rw 挂载（2026-11-07 决策 13：管理员投放与运维共享文件继续
 * 全员可读写，经验库不做容器级隔离，保留软链 + 提示词收口）；deps/HOME/tmp/workspace/
 * userSkills 维持用户级共享（已拍板决策 2/3）。
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
   * 只传入经数据库按 (user_id, agent_id) 过滤的该用户该 Agent 自己的会话工作区。
   * 群聊工作区由同群多个用户的会话按设计共享，挂进各自容器不构成跨用户泄漏。
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
  /**
   * 平台共享技能源：技能视图（skillViewsDir）的拷贝来源。
   * 技术方案 2026-11-03 G1/G2：该目录不再挂载进容器（源对容器不可见、不可写），
   * 仅保留为登记根参与挂载清单校验（父目录防护等）。
   */
  skillsDir: string;
  /**
   * 技能视图根：容器内按 (user, agent) 挂 {skillViewsDir}/{userId}/{agentId}（ro）。
   * 视图是用户+Agent 级只读技能副本，会话技能软链指向这里（SkillSyncService）。
   */
  skillViewsDir: string;
  /** rw 项：图片产物上传根（FILE_UPLOAD_DIR），按用户挂 {uploadDir}/{userId}。 */
  uploadDir: string;
  /** rw 项：每用户 /tmp 持久根，{tmpDir}/{userId} 映射到容器 /tmp。 */
  tmpDir: string;
  /**
   * rw 项：公共共享目录根（共享目录方案 2026-10-21：管理员宿主机投放，全员只读语义
   * 在经验库方案 2026-10-24 起放宽为整根 rw）。2026-11-07 决策 13：维持整根 rw 挂载，
   * 管理员投放与运维共享文件对所有容器可读写；经验库隔离保留软链 + 提示词收口。
   */
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
   * 生成 (userId, agentId) 的挂载清单。生成后立即 assertSafe，任何不合法条目直接抛错
   * （宁可启动失败也不把越界挂载带进容器）。
   *
   * extraWorkspaces：该用户该 Agent 的通道会话（飞书/钉钉）的工作区绝对路径，越出
   * 每用户根、但属该用户该 Agent 自己的会话（调用方按数据库 (user_id, agent_id) 过滤后
   * 传入；私聊叶子另在 planSessionWorkspace 内做本人校验）。web 会话工作区在
   * {workspaceRoot}/{userId} 之下已被覆盖，无需传入。
   */
  plan(userId: number, agentId: number, extraWorkspaces: readonly string[] = []): ContainerMount[] {
    const u = String(userId);
    const a = String(agentId);
    this.assertShareDirIndependent();
    const mounts: ContainerMount[] = [
      { hostPath: this.under(this.roots.userHomeDir, u), containerPath: this.under(this.roots.userHomeDir, u), mode: 'rw', purpose: 'userHome' },
      { hostPath: this.under(this.roots.workspaceRoot, u), containerPath: this.under(this.roots.workspaceRoot, u), mode: 'rw', purpose: 'workspace' },
      { hostPath: this.under(this.roots.runtimeDir, u), containerPath: this.under(this.roots.runtimeDir, u), mode: 'rw', purpose: 'runtime' },
      { hostPath: this.under(this.roots.depsDir, u), containerPath: this.under(this.roots.depsDir, u), mode: 'rw', purpose: 'deps' },
      { hostPath: this.under(this.roots.channelDir, u, a), containerPath: this.under(this.roots.channelDir, u, a), mode: 'rw', purpose: 'channel' },
      { hostPath: this.under(this.roots.userSkillsDir, u), containerPath: this.under(this.roots.userSkillsDir, u), mode: 'rw', purpose: 'userSkills' },
      { hostPath: this.under(this.roots.uploadDir, u), containerPath: this.under(this.roots.uploadDir, u), mode: 'rw', purpose: 'uploads' },
      // 每用户 /tmp 持久化：宿主 {tmpDir}/{userId} 映射到容器 /tmp（路径映射的唯一例外），
      // 跨 stop/重建保留；3077 语义由 assertSafe 统一 chmod 1777。用户级共享（决策 2）。
      { hostPath: this.under(this.roots.tmpDir, u), containerPath: '/tmp', mode: 'rw', purpose: 'tmp' },
      { hostPath: this.under(this.roots.distDir, ''), containerPath: this.under(this.roots.distDir, ''), mode: 'ro', purpose: 'dist' },
      // 公共共享目录（2026-10-21 方案 + 2026-10-24 经验库；2026-11-07 决策 13 维持原状）：
      // 整根 rw——管理员投放与运维共享文件对全员可读写；经验库由工作区软链收口到本 Agent
      // 子目录（容器内仍可经 share 根触达其他 Agent 的库，属已拍板的接受项）。
      // 注意 mode 参与挂载指纹：ro→rw 变更会触发存量容器自动重建。
      { hostPath: this.under(this.roots.shareDir, ''), containerPath: this.under(this.roots.shareDir, ''), mode: 'rw', purpose: 'share' },
      // 技能视图（技术方案 2026-11-03 §4.4；2026-11-07 按 agent 收窄）：系统技能的
      // 用户+Agent 级只读副本，会话软链指向这里；源目录（skillsDir）整体不进容器
      // （G1：容器内不可见 / G2：只读）。挂载路径恒定：skillNames 增删 / 技能源更新
      // 只改目录内容（容器 ro 即见），不触发容器重建。
      // 注意 mode 参与挂载指纹：rw→ro 变更会触发存量容器自动重建。
      { hostPath: this.under(this.roots.skillViewsDir, u, a), containerPath: this.under(this.roots.skillViewsDir, u, a), mode: 'ro', purpose: 'skillViews' },
    ];
    for (const workspace of extraWorkspaces) {
      const mount = this.planSessionWorkspace(workspace, userId);
      // null = 每用户工作区根之下，标准清单已覆盖；重复传入只挂一份
      if (!mount || mounts.some((m) => m.hostPath === mount.hostPath)) continue;
      mounts.push(mount);
    }
    this.assertSafe(mounts, userId, agentId);
    return mounts;
  }

  /**
   * shareDir 独立性校验（共享目录方案 §4.1 等式盲区）：shareDir 若等于某个按用户
   * 收窄的登记根、或位于其下（如误配为 workspaceRoot 自身或 {workspaceRoot}/7），
   * 现有 assertSafe 规则全部放行——这些根按 {root}/{userId} 挂载，容器路径不重复；
   * 父目录防护对等式 continue 跳过——整棵每用户数据会以只读/可写挂进所有容器，构成跨用户
   * 可读/可写。技能根（skillsDir / skillViewsDir）同理：视图根含全部用户子目录，
   * 等值误配会把所有用户的授权技能整棵挂进每个容器；技能源等值误配等于把「永不进容器」
   * 的共享源重新挂进去（skills 挂载移除后不再有重复容器路径兜底，须显式拒绝）。
   * 放在 plan() 而非构造器：host 模式不起容器，不应因误配在启动时炸掉。
   */
  private assertShareDirIndependent(): void {
    const share = path.resolve(this.roots.shareDir);
    const perUserRoots = [
      this.roots.workspaceRoot, this.roots.runtimeDir, this.roots.userHomeDir,
      this.roots.userSkillsDir, this.roots.uploadDir, this.roots.channelDir,
      this.roots.depsDir, this.roots.tmpDir,
      this.roots.skillViewsDir, this.roots.skillsDir,
      // dist（2026-11-07 补）：share 等值 dist 会与 dist 只读挂载产生重复容器路径冲突；
      // 位于其下会在 dist 只读树内开出 rw 洞（子挂载遮蔽），必须显式拒绝
      this.roots.distDir,
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
    const ref = parseChannelWorkspace(host, this.roots.workspaceRoot);
    if (ref == null) {
      throw new MountPlanError(`mount sessionWorkspace: ${host} must be a concrete {account}/{leaf} workspace under ${owning}`);
    }
    // 归属校验（N-5，纵深防御）：私聊工作区只允许挂进本人容器——飞书 private-{userId}、
    // 钉钉 p2p-{userId}。session.workspace 是用户可控字段（建会话 API 原样落库），缺少
    // 这道校验时可把其他用户的飞书/钉钉私聊工作区以 rw 挂进本人容器。群聊工作区
    // （leaf 为 chatId / conversationId）按设计由同群多用户会话共享，不在此判定；
    // 用户自建会话的通道工作区入口已在建会话侧按归属收口（session.routes.ts），
    // 这里是不依赖上游永远正确的第二道
    if (ref.ownerUserId != null && ref.ownerUserId !== userId) {
      throw new MountPlanError(
        `mount sessionWorkspace: private workspace ${ref.leaf} does not belong to user ${userId}: ${host}`,
      );
    }
    return { hostPath: host, containerPath: host, mode: 'rw', purpose: 'sessionWorkspace', sessionWorkspace: true };
  }

  /**
   * 校验规则（技术方案 §5.1；2026-11-07 增补 agent 维度）：
   * - 每条源路径必须位于已登记数据根之下（或 ro 项等于其根自身）；
   * - rw 项的源路径必须以 /{userId} 结尾或包含 /{userId}/ 段，拒绝任何上级目录；
   * - agent 维度条目（skillViews / channel）必须恰为 {登记根}/{userId}/{agentId}，
   *   防借 purpose 扩大到其他 Agent 或上级；
   * - dist 只读，不得被覆写为 rw；
   * - 源路径不得是另一个已登记数据根的父目录（如挂 /opt/mao-data 整体）；
   * - 符号链接源路径 realpath 后仍必须在登记根内（防链接逃逸）；
   * - 同一容器内路径不得重复挂载。
   */
  assertSafe(mounts: ContainerMount[], userId: number, agentId: number): void {
    const u = String(userId);
    const a = String(agentId);
    const expectedAgentPaths: Record<string, string> = {
      skillViews: this.under(this.roots.skillViewsDir, u, a),
      channel: this.under(this.roots.channelDir, u, a),
    };
    // 技能视图根与 shareDir 互不包含（技术方案 2026-11-03 §4.4 评审修订）：share 子目录 rw
    // 与视图根嵌套会产生挂载语义歧义（同一视图目录既被 ro 精确挂载、其父又被 rw 粗粒度打通）。
    // 正向（shareDir 位于视图根之内/相等）由 assertShareDirIndependent 拦截，这里显式补齐反向。
    const shareRoot = path.resolve(this.roots.shareDir);
    const viewsRoot = path.resolve(this.roots.skillViewsDir);
    if (viewsRoot === shareRoot || viewsRoot.startsWith(shareRoot + path.sep)) {
      throw new MountPlanError(`skillViewsDir ${viewsRoot} must not be or under shareDir ${shareRoot}`);
    }
    const registeredRoots = [
      this.roots.userHomeDir, this.roots.runtimeDir, this.roots.workspaceRoot,
      this.roots.depsDir, this.roots.userSkillsDir, this.roots.channelDir,
      this.roots.distDir, this.roots.skillsDir, this.roots.skillViewsDir,
      this.roots.uploadDir, this.roots.tmpDir,
      this.roots.shareDir,
    ].map((r) => path.resolve(r));

    const seenContainerPaths = new Set<string>();
    for (const mount of mounts) {
      const host = path.resolve(mount.hostPath);
      // agent 维度条目：必须恰为 {登记根}/{userId}/{agentId}，
      // 挂到其他 Agent 的目录 / 用户根 / 上级一律拒绝（2026-11-07 收口）
      const expectedAgentPath = expectedAgentPaths[mount.purpose];
      if (expectedAgentPath != null && host !== expectedAgentPath) {
        throw new MountPlanError(`mount ${mount.purpose}: host path ${host} must be exactly ${expectedAgentPath} for user=${u} agent=${a}`);
      }
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
        // 共享目录整根 rw 例外（2026-10-24 D10；2026-11-07 决策 13 维持）：share 根
        // 需容器内写入（经验库 + 管理员投放共享语义），必须恰为登记的 shareDir 根，
        // 防借 purpose 扩大到子路径外或上级。
        const isSharedShareRoot = mount.purpose === 'share' && host === path.resolve(this.roots.shareDir);
        // rw 项必须含 userId 尾段/中间段，拒绝把整个数据根或上级挂进容器。
        // 通道会话工作区（sessionWorkspace）按 {account}/{leaf} 结构性豁免 + 私聊
        // 叶子归属校验（planSessionWorkspace），并由调用方按数据库 (user_id, agent_id) 过滤保证
        if (!isSharedShareRoot) {
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
  standardMountsFingerprint(userId: number, agentId: number): string {
    return this.fingerprintOf(this.plan(userId, agentId).filter((m) => !m.sessionWorkspace));
  }

  /** 给定挂载子集的指纹（createAndStart 复用同一次 plan 的结果，避免二次规划）。 */
  fingerprintOf(mounts: readonly ContainerMount[]): string {
    return fingerprintOfMounts(mounts);
  }

  /** 挂载清单审计日志（user/agent + 完整挂载表）。 */
  auditLog(userId: number, agentId: number, mounts: ContainerMount[]): void {
    for (const m of mounts) {
      harnessLog('info', `[container-mount] user=${userId} agent=${agentId} ${m.purpose}: ${m.hostPath} -> ${m.containerPath} (${m.mode})`);
    }
  }

  private containsUserSegment(rel: string, u: string): boolean {
    if (rel === u) return true;
    const parts = rel.split(path.sep);
    return parts.includes(u);
  }

  private under(root: string, ...leaves: string[]): string {
    const nonEmpty = leaves.filter((leaf) => leaf !== '');
    return nonEmpty.length === 0 ? path.resolve(root) : path.join(path.resolve(root), ...nonEmpty);
  }
}
