import { execFile as execFileCb } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';
import { harnessLog } from '../log.js';
import type { CloudRuntimeConfig } from '../../config/app-config.js';
import { ContainerMountPlanner, type ContainerMount } from './container-mount-planner.js';
import { isChannelWorkspace } from './channel-workspace.js';
import type { RuntimeStatus } from './runtime-channel-server.js';

/**
 * 容器生命周期注册表（宿主机单例，技术方案 §5.2）。
 * create / start / stop / reuse、idle 与 lifetime 回收、资源限制、启动预检。
 * docker 命令统一经 DockerCli 调用，单测注入 fake。
 *
 * 并发模型（N-4a/b/c）：同一用户的全部生命周期操作（创建、重启、recycle、stop）
 * 经 withUserLock 按用户串行。容器名固定为 mao-user-{userId}，两个并发调用各自
 * 执行"停-删-建"会互相摧毁对方刚建好的容器，并让在册条目的挂载集合与真实容器
 * 错位（重复重建、条目被删、容器被 rm -f）。
 * recycle 走原地更新条目（对象身份不变、generation +1）：并发调用方持有的句柄
 * 始终是在册条目，startedAtMs/mountedPaths 不会错位；await 之后的副作用点靠
 * generation 识别条目已被重建，避免按容器名误伤新容器。
 */
export interface ContainerEntry {
  userId: number;
  containerName: string;
  state: 'creating' | 'running' | 'stopped';
  startedAtMs: number;
  lastUsedAtMs: number;
  /** 容器内活跃状态（runtime_status 上报，§5.3.1）：有活跃 shell/任务/终端时 idle 不推进。 */
  inContainer: RuntimeStatus;
  /** 连接断开（容器内 agent 未重连）时置 true，下次 ensureRunning 触发重建。 */
  connectionDead: boolean;
  /**
   * 本次 docker run 固化的挂载源路径集合（N-2）。docker 挂载清单在创建时定型，
   * 运行中/停止后启动都无法新增：会话工作区不在集合内时 ensureRunning 只能重建容器。
   */
  mountedPaths: ReadonlySet<string>;
  /** 本次挂载的通道会话工作区（mountedPaths 中除每用户标准根之外的部分），重建时并入新清单。 */
  sessionWorkspaces: readonly string[];
  /**
   * 条目世代：每次 docker run/start 成功 +1。recycle 原地更新条目（对象身份不变），
   * 世代用于在 await 之后识别"条目已被重建"，防止陈旧副作用点按容器名误伤新容器。
   */
  generation: number;
  /**
   * 本次 docker run 固化的标准挂载计划指纹（planner.standardMountsFingerprint）。
   * 挂载清单在 docker run 时定型：planner 变更（新增 uploads 挂载等）后既有容器
   * 不会自动重建，指纹漂移时 ensureRunning 主动回收重建（一次性代价）。
   * 缺省（升级过渡的旧条目 / 测试手工构造）视为漂移，自然自愈一次。
   */
  mountFingerprint?: string;
}

export interface DockerCli {
  run(args: string[], timeoutMs: number): Promise<string>;
}

export class DockerCliImpl implements DockerCli {
  run(args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      execFileCb('docker', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`docker ${args.join(' ')} failed: ${(err as Error).message}${stderr ? ' | ' + stderr.trim() : ''}`));
        } else {
          resolve(stdout);
        }
      });
    });
  }
}

export class ContainerStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContainerStartError';
  }
}

export interface ContainerRegistryOptions {
  config: CloudRuntimeConfig;
  workspaceRoot: string;
  userHomeDir: string;
  runtimeDir: string;
  userSkillsDir: string;
  skillsDir: string;
  /** 图片产物上传根（FILE_UPLOAD_DIR）：按用户挂 {uploadDir}/{userId} 并注入容器 env。 */
  uploadDir: string;
  /** 公共共享目录（共享目录方案 §4.3）：ro 挂载进每用户容器并注入容器 env。 */
  shareDir: string;
  /** 创建前确保宿主机 socket server 已监听（先 listen 再 docker run），返回 socket 路径。 */
  ensureChannelListening(userId: number): Promise<string>;
  /** 创建前确保该用户连接 token 已落盘（容器启动时经 -e 注入）。 */
  issueChannelToken(userId: number): string;
  /** 容器启动命令等待 socket 就绪时轮询连接的回调。 */
  waitSocketReady(userId: number, timeoutMs: number): Promise<void>;
  /** 停止前发 shutdown 帧让容器收尾（§5.3.1 对策 3）。返回 false 表示容器无响应。 */
  requestShutdown(userId: number): Promise<boolean>;
  /**
   * 该用户当前会话使用的工作区绝对路径（N-2）。创建/重建容器时把越出每用户根的
   * 通道会话工作区一并挂入；返回空数组或未注入时行为与旧版一致。
   * 实现必须按数据库 user_id 过滤（归属校验），不得返回其他用户的工作区。
   */
  sessionWorkspacesOf?(userId: number): Promise<string[]>;
}

const IDLE_CHECK_INTERVAL_MS = 60_000;

export class ContainerRegistry {
  private readonly entries = new Map<number, ContainerEntry>();
  /** 每用户串行锁：值是该用户上一个 Section 的占位 Promise，后到者链接到链尾。 */
  private readonly userLocks = new Map<number, Promise<unknown>>();
  /** 持锁上下文：识别同一异步上下文内的重入（requestShutdown 回调里触发 ensureRunning），避免自死锁。 */
  private readonly lockContext = new AsyncLocalStorage<Set<number>>();
  private readonly planner: ContainerMountPlanner;
  private idleTimer: NodeJS.Timeout | null = null;
  /** 每用户 /tmp 过期清理节流（24h 一次，容器创建 / idle 巡检触发）。 */
  private lastTmpCleanupAtMs = 0;

  constructor(
    private readonly opts: ContainerRegistryOptions,
    private readonly docker: DockerCli = new DockerCliImpl(),
  ) {
    const c = opts.config.container;
    this.planner = new ContainerMountPlanner({
      userHomeDir: opts.userHomeDir,
      runtimeDir: opts.runtimeDir,
      workspaceRoot: opts.workspaceRoot,
      depsDir: c.depsDir,
      userSkillsDir: opts.userSkillsDir,
      channelDir: c.channelDir,
      distDir: c.distDir,
      skillsDir: opts.skillsDir,
      uploadDir: opts.uploadDir,
      tmpDir: c.tmpDir,
      shareDir: opts.shareDir,
    });
  }

  static containerName(userId: number): string {
    return `mao-user-${userId}`;
  }

  get mountsPlanner(): ContainerMountPlanner {
    return this.planner;
  }

  /** docker 模式启动预检：任一不满足直接抛错，不静默降级（§5.2）。 */
  async precheck(): Promise<void> {
    const c = this.opts.config.container;
    await this.docker.run(['version', '--format', '{{.Server.Version}}'], 10_000);
    const images = await this.docker.run(['images', '--format', '{{.Repository}}:{{.Tag}}', c.image], 10_000);
    if (!images.split('\n').some((line) => line.trim() === c.image)) {
      throw new ContainerStartError(
        `容器镜像 ${c.image} 不存在。请先运行 scripts/build-runtime-image.sh 构建运行时镜像`,
      );
    }
    if (!existsSync(c.channelDir) || !isWritable(c.channelDir)) {
      throw new ContainerStartError(`socket 根目录不可写: ${c.channelDir}`);
    }
    // 依赖冒烟（2026-10-30 事故回归）：容器侧 agent 的第三方依赖全部来自镜像的
    // node_modules、代码来自宿主机只读挂载的 dist。backend-ts 新增 npm 依赖（如团队经验库
    // 引入的 yaml）后若镜像未重建，容器内 agent 启动即 ERR_MODULE_NOT_FOUND 退出，表现为
    // 每个用户工具调用等满 startTimeoutMs 后报「容器运行时通道连接超时」。这里用当前 dist
    // 实际加载一次，把「镜像与 dist 依赖不匹配」拦在切模式（后台保存 runtime.mode）之前。
    await this.assertImageLoadsRuntimeAgent();
    harnessLog('info', `[container] precheck OK: image=${c.image}`);
  }

  /**
   * 镜像 + 当前 dist 的加载冒烟（precheck 调用）。
   * - 只加载不运行：node -e 下 process.argv[1] 为空，runtime-agent 的 isMainModule 判定为
   *   false，不会真的启动 agent；
   * - sharp / node-pty 一并加载：两者是镜像里的 native 模块，宿主机 Node 升级后漏重建
   *   镜像会导致容器内读图/pty 静默失败（§4），这里提前显性暴露；
   * - 工作目录取 dist 的父目录：镜像把 backend-ts 的 node_modules 装在该层（见
   *   Dockerfile.runtime），bare import 才能命中。
   */
  private async assertImageLoadsRuntimeAgent(): Promise<void> {
    const c = this.opts.config.container;
    const distDir = path.resolve(c.distDir);
    const agentEntry = `file://${distDir}/harness/container/runtime-agent.js`;
    const code = `Promise.all([import('${agentEntry}'), import('sharp'), import('node-pty')])`
      + `.catch((e) => { console.error('[precheck]', (e && e.message) || e); process.exit(1); });`;
    try {
      await this.docker.run([
        'run', '--rm',
        '-w', path.dirname(distDir),
        '-v', `${distDir}:${distDir}:ro`,
        c.image,
        'node', '-e', code,
      ], 60_000);
    } catch (e) {
      throw new ContainerStartError(
        `运行时镜像 ${c.image} 无法加载当前 dist 的 runtime-agent（容器内依赖与代码不匹配，通常是有新增 npm 依赖或 Node 版本升级后未重建镜像；请执行 scripts/build-runtime-image.sh 后重试）: ${(e as Error).message}`,
      );
    }
  }

  getEntry(userId: number): ContainerEntry | undefined {
    return this.entries.get(userId);
  }

  /**
   * ensureRunning：不存在则创建并等待就绪；stopped 则 start；running 直接复用。
   * 全程按用户串行（见类注释），requiredWorkspace 的挂载检查与必要的重建都在锁内
   * 完成，不存在"登记条目后又被并发重建替换"的窗口。
   *
   * requiredWorkspace：本次调用所属会话的工作区（N-2）。docker 挂载清单在 docker run
   * 时定型，运行中容器无法新增挂载：工作区不在已挂载集合内时重建容器（旧容器内既有
   * shell/pty/在途任务随重建丢失，这是把新通道会话工作区纳入容器的必要代价，仅在
   * 用户新建该类会话的首次调用时发生）。web 会话工作区在 {workspaceRoot}/{userId}
   * 之下，命中已挂载集合，不会触发重建。
   */
  async ensureRunning(userId: number, requiredWorkspace?: string | null): Promise<ContainerEntry> {
    return this.withUserLock(userId, () => this.ensureRunningLocked(userId, requiredWorkspace));
  }

  private async ensureRunningLocked(userId: number, requiredWorkspace?: string | null): Promise<ContainerEntry> {
    const entry = this.entries.get(userId);
    if (!entry) {
      const created = await this.createAndStart(userId, requiredWorkspace ? [requiredWorkspace] : []);
      return this.ensureWorkspaceMounted(created, requiredWorkspace);
    }
    if (entry.state === 'running' && !entry.connectionDead) {
      // 挂载计划漂移（planner 变更，如新增 uploads 挂载）：docker start/复用都不会
      // 补上新挂载，只能重建。指纹缺省（旧条目/测试构造）同样按漂移处理，自愈一次
      if (this.mountPlanDrifted(entry, userId)) {
        harnessLog('warn', `[container] recreating container for user=${userId} (mount plan changed)`);
        return this.ensureWorkspaceMounted(
          await this.rebuildEntry(entry, entry.sessionWorkspaces),
          requiredWorkspace,
        );
      }
      entry.lastUsedAtMs = Date.now();
      return this.ensureWorkspaceMounted(entry, requiredWorkspace);
    }
    if (entry.state === 'stopped' && !entry.connectionDead) {
      // 停止期间（idle 回收后）新增的通道会话工作区只能随完整重建挂入：docker start
      // 复用创建时的挂载清单，带不上新目录。requiredWorkspace 一并参与判定，避免
      // "先 docker start 再立刻重建"的一次无用启动；挂载计划漂移同理（先判定再 start）
      const desired = [
        ...await this.sessionWorkspaces(userId),
        ...(requiredWorkspace ? [path.resolve(requiredWorkspace)] : []),
      ].filter((p) => isChannelWorkspace(p, this.opts.workspaceRoot));
      if (this.hasUnmountedWorkspace(entry, desired) || this.mountPlanDrifted(entry, userId)) {
        harnessLog('warn', `[container] recreating container for user=${userId} (new session workspaces or mount plan changed while stopped)`);
        return this.ensureWorkspaceMounted(
          await this.rebuildEntry(entry, [...entry.sessionWorkspaces, ...desired]),
          requiredWorkspace,
        );
      }
      entry.lastUsedAtMs = Date.now();
      await this.dockerStart(entry);
      return this.ensureWorkspaceMounted(entry, requiredWorkspace);
    }
    // connectionDead（容器内 agent 失联）或状态异常：停止旧容器后重建
    harnessLog('warn', `[container] rebuilding container for user=${userId} (state=${entry.state}, dead=${entry.connectionDead})`);
    const extras = [...entry.sessionWorkspaces, ...await this.sessionWorkspaces(userId)];
    await this.stopContainer(entry, { force: true });
    return this.ensureWorkspaceMounted(await this.rebuildEntry(entry, extras), requiredWorkspace);
  }

  /**
   * 按用户串行化容器生命周期操作（N-4a/b/c）。同一用户同一时刻只有一个 Section 在
   * 执行：创建、重启、recycle、stop 全部在其中完成，从结构上消除"两个并发调用各自
   * 停-删-建、互相摧毁对方刚建好的容器"这类竞态。
   *
   * 重入：同一异步上下文内已持有该用户锁时直接执行（stopContainer 的 requestShutdown
   * 回调里同步触发 ensureWorking 的场景），不识别重入会自死锁。
   */
  private withUserLock<T>(userId: number, section: () => Promise<T>): Promise<T> {
    const held = this.lockContext.getStore();
    if (held?.has(userId)) return section();
    const chained = this.lockContext.run(
      new Set([...(held ?? []), userId]),
      () => (this.userLocks.get(userId) ?? Promise.resolve()).then(section, section),
    );
    // 链尾只保留"已 settles"的占位：单个 Section 失败不污染后续排队者
    this.userLocks.set(
      userId,
      chained.then(
        () => undefined,
        () => undefined,
      ),
    );
    return chained;
  }

  /** 该用户会话工作区（供挂载清单附加项）；未注入回调时为空。 */
  private async sessionWorkspaces(userId: number): Promise<string[]> {
    if (!this.opts.sessionWorkspacesOf) return [];
    try {
      const list = await this.opts.sessionWorkspacesOf(userId);
      if (!Array.isArray(list)) return [];
      // 防御性过滤：只放行通道工作区（结构校验见 ContainerMountPlanner.planSessionWorkspace）。
      // web 会话在每用户根内无需附加；其余异常形态忽略，由 ensureRunning 的明确报错兜底
      return list.filter((p): p is string => typeof p === 'string' && p.length > 0)
        .map((p) => path.resolve(p))
        .filter((p) => isChannelWorkspace(p, this.opts.workspaceRoot));
    } catch (e) {
      // 查询失败不阻塞容器创建：附加挂载缺失时通道会话按明确报错失败，好过静默错位
      harnessLog('warn', `[container] session workspace lookup failed for user=${userId}: ${(e as Error).message}`);
      return [];
    }
  }

  /** 路径是否已被当前挂载清单覆盖（等于某挂载源或位于其下）。 */
  private isMounted(entry: ContainerEntry, workspace: string): boolean {
    const target = path.resolve(workspace);
    for (const mounted of entry.mountedPaths) {
      if (target === mounted || target.startsWith(mounted + path.sep)) return true;
    }
    return false;
  }

  private hasUnmountedWorkspace(entry: ContainerEntry, workspaces: readonly string[]): boolean {
    return workspaces.some((w) => !this.isMounted(entry, w));
  }

  /**
   * 标准挂载计划是否已漂移（条目固化的指纹与当前 planner 产出不一致）。docker 挂载
   * 清单在 docker run 时定型，planner 变更（新增 uploads 挂载、根路径调整）后既有
   * 容器永远补不上新挂载；指纹缺省按漂移处理，让升级过渡的旧条目自愈重建一次。
   */
  private mountPlanDrifted(entry: ContainerEntry, userId: number): boolean {
    return entry.mountFingerprint !== this.planner.standardMountsFingerprint(userId);
  }

  /**
   * 运行中容器的工作区挂载检查（N-2）：
   * - 已挂载（每用户根之下的 web 会话工作区即此列）→ 直接返回；
   * - 未挂载但是通道会话工作区 → 重建容器把该工作区并入挂载清单；
   * - 未挂载也不是通道工作区 → 容器内永远不可见，明确抛错。绝不让"容器内目录
   *   不存在"退化成的空输出 / 会话秒退这类无法归因的静默失败，也不做无意义的重建。
   */
  private async ensureWorkspaceMounted(entry: ContainerEntry, workspace?: string | null): Promise<ContainerEntry> {
    if (!workspace) return entry;
    const target = path.resolve(workspace);
    if (this.isMounted(entry, target)) return entry;
    if (!isChannelWorkspace(target, this.opts.workspaceRoot)) {
      throw new ContainerStartError(
        `会话工作区不在容器可挂载范围内（仅支持每用户工作区与飞书/钉钉通道工作区）: ${target}`,
      );
    }
    harnessLog('warn', `[container] recycling container user=${entry.userId} to mount session workspace ${target}`);
    // 保留此前已挂载的会话工作区，只增量并入新工作区（rebuildEntry 原地更新条目）
    await this.rebuildEntry(entry, [...entry.sessionWorkspaces, target]);
    if (!this.isMounted(entry, target)) {
      throw new ContainerStartError(
        `会话工作区不在容器可挂载范围内（仅支持每用户工作区与飞书/钉钉通道工作区）: ${target}`,
      );
    }
    return entry;
  }

  /**
   * 重建容器（recycle）：停旧容器（如仍在运行）→ rm → docker run 新建 → 原地更新条目。
   * 条目对象身份不变，持有旧句柄的并发调用方看到的始终是在册条目（N-4b）。
   * 调用方必须持有该用户的串行锁。
   */
  private async rebuildEntry(entry: ContainerEntry, extraWorkspaces: readonly string[]): Promise<ContainerEntry> {
    if (entry.state !== 'stopped') {
      await this.stopContainer(entry, { force: true });
    }
    // 停止的容器仍占用容器名：不 rm 掉的话 docker run 同名必然冲突
    await this.cleanupHalfCreated(entry.containerName);
    return this.createAndStart(entry.userId, extraWorkspaces, entry);
  }

  /** 宿主机主动标记连接断开（RuntimeChannelServer onConnectionDead 回调）。 */
  markConnectionDead(userId: number): void {
    const entry = this.entries.get(userId);
    if (entry) entry.connectionDead = true;
  }

  reportRuntimeStatus(userId: number, status: RuntimeStatus): void {
    const entry = this.entries.get(userId);
    if (entry) entry.inContainer = status;
  }

  startIdleLoop(): void {
    if (this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      void this.reapExpired().catch((e) => harnessLog('warn', `[container] idle reap failed: ${(e as Error).message}`));
      this.cleanupExpiredTmp();
    }, IDLE_CHECK_INTERVAL_MS);
    this.idleTimer.unref?.();
  }

  stopIdleLoop(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  /**
   * 每用户 /tmp 过期条目清理：24h 最多一次（容器创建与 idle 巡检触发）。
   * 只清 {tmpDir}/{数字 userId} 目录内 mtime 超过阈值的顶层条目，目录本身保留；
   * 单项失败不影响其余条目。
   */
  private cleanupExpiredTmp(): void {
    if (Date.now() - this.lastTmpCleanupAtMs < 24 * 3600_000) return;
    this.lastTmpCleanupAtMs = Date.now();
    const c = this.opts.config.container;
    const days = c.tmpRetentionDays > 0 ? c.tmpRetentionDays : 7;
    const retentionMs = days * 86400_000;
    let users: string[];
    try { users = readdirSync(c.tmpDir); } catch { return; }
    for (const name of users) {
      if (!/^\d+$/.test(name)) continue;
      const dir = path.join(c.tmpDir, name);
      try {
        const st = lstatSync(dir);
        if (!st.isDirectory() || st.isSymbolicLink()) continue;
      } catch { continue; }
      let entries: string[];
      try { entries = readdirSync(dir); } catch { continue; }
      for (const entry of entries) {
        const target = path.join(dir, entry);
        try {
          if (Date.now() - lstatSync(target).mtimeMs > retentionMs) {
            rmSync(target, { recursive: true, force: true });
          }
        } catch { /* 单项失败不阻塞其它条目 */ }
      }
    }
  }

  /** 应用关闭时停掉本实例管理的容器（数据在挂载卷，下次 start 秒级恢复）。 */
  async stopAllForShutdown(): Promise<void> {
    for (const entry of [...this.entries.values()]) {
      await this.withUserLock(entry.userId, () => this.stopContainer(entry, { force: false })).catch(() => undefined);
    }
  }

  /** idle/lifetime 回收巡检（供 idle loop 与测试直接调用）。 */
  async reapExpired(): Promise<void> {
    const c = this.opts.config.container;
    const idleMs = c.idleMinutes * 60_000;
    const lifetimeMs = c.maxLifetimeHours * 3600_000;
    for (const entry of [...this.entries.values()]) {
      if (entry.state !== 'running') continue;
      // §5.3.1：容器内有活跃 shell 会话/未消费任务/attach 终端时 idle 与 lifetime 都不推进
      const busy = this.isBusy(entry);
      if (busy) continue;
      const idle = Date.now() - entry.lastUsedAtMs > idleMs;
      const expired = Date.now() - entry.startedAtMs > lifetimeMs;
      if (!idle && !expired) continue;
      harnessLog('info', `[container] stopping container user=${entry.userId} (idle=${idle}, lifetimeExpired=${expired})`);
      // 按用户串行：等锁期间条目可能已被 recycle 原地重建，锁内复核后再停
      await this.withUserLock(entry.userId, async () => {
        if (this.entries.get(entry.userId) !== entry) return;
        if (entry.state !== 'running') return;
        if (this.isBusy(entry)) return;
        const idleNow = Date.now() - entry.lastUsedAtMs > idleMs;
        const expiredNow = Date.now() - entry.startedAtMs > lifetimeMs;
        if (!idleNow && !expiredNow) return;
        await this.stopContainer(entry, { force: false });
      });
    }
  }

  private isBusy(entry: ContainerEntry): boolean {
    return entry.inContainer.shellSessions > 0 || entry.inContainer.pendingTasks > 0 || entry.inContainer.attachedTerminals > 0;
  }

  /**
   * 创建并启动容器。existing 非空表示 recycle 的原地重建：条目对象身份不变，
   * 只更新容器相关状态（N-4b）。
   */
  private async createAndStart(
    userId: number,
    extraWorkspaces: readonly string[] = [],
    existing?: ContainerEntry,
  ): Promise<ContainerEntry> {
    this.cleanupExpiredTmp();
    const name = ContainerRegistry.containerName(userId);
    const c = this.opts.config.container;
    // 会话工作区（通道会话）并入挂载清单。统一按通道根过滤：web 会话工作区在
    // {workspaceRoot}/{userId} 之内、由标准清单覆盖，显式传入也不需要附加挂载
    const sessionWorkspaces = [...new Set([
      ...await this.sessionWorkspaces(userId),
      ...extraWorkspaces.map((p) => path.resolve(p)),
    ])].filter((p) => isChannelWorkspace(p, this.opts.workspaceRoot));
    const mounts = this.planner.plan(userId, sessionWorkspaces);
    // 指纹与 standardMountsFingerprint 同源（共享序列化口径）：只含标准挂载，
    // 动态会话工作区不进指纹，否则每次新通道会话都会误判漂移触发重建
    const mountFingerprint = this.planner.fingerprintOf(mounts.filter((m) => !m.sessionWorkspace));
    this.planner.auditLog(userId, mounts);
    // 先 listen 再 run：容器 agent 启动即连 socket，宿主机没监听时只会无限重连
    const socketPath = await this.opts.ensureChannelListening(userId);
    const channelToken = this.opts.issueChannelToken(userId);
    const args = [
      'run', '-d',
      '--name', name,
      '--label', 'mao.runtime=user',
      '--label', `mao.user=${userId}`,
      '--memory', `${c.memoryMb}m`,
      '--cpus', String(c.cpus),
      '--pids-limit', String(c.pidsLimit),
      '--network', c.network,
      // /tmp 由 planner 按 {tmpDir}/{userId} 挂载（持久化，跨重建保留），不再使用 --tmpfs。
      // 容器 agent 硬依赖：userId 缺失即 exit(1)；roots 显式注入避免容器内出现第二套路径真相
      '-e', `MAO_CONTAINER_USER_ID=${userId}`,
      '-e', `MAO_CHANNEL_TOKEN=${channelToken}`,
      '-e', `MAO_WORKSPACE_ROOT=${this.opts.workspaceRoot}`,
      '-e', `MAO_RUNTIME_DIR=${this.opts.runtimeDir}`,
      '-e', `MAO_USER_HOME_DIR=${this.opts.userHomeDir}`,
      '-e', `MAO_USER_SKILLS_DIR=${this.opts.userSkillsDir}`,
      '-e', `MAO_UPLOAD_DIR=${this.opts.uploadDir}`,
      '-e', `MAO_SHARE_DIR=${this.opts.shareDir}`,
      ...this.planner.toDockerArgs(mounts),
      // 容器不暴露任何端口：进出只走 Unix socket（§5.2）
      '--restart', 'no',
      c.image,
      'node', path.posix.join(c.distDir, 'harness/container/runtime-agent.js'),
      '--socket', socketPath,
    ];
    const entry: ContainerEntry = existing ?? {
      userId,
      containerName: name,
      state: 'creating',
      startedAtMs: 0,
      lastUsedAtMs: 0,
      inContainer: { shellSessions: 0, pendingTasks: 0, attachedTerminals: 0 },
      connectionDead: false,
      mountedPaths: new Set<string>(),
      sessionWorkspaces: [],
      generation: 0,
    };
    entry.state = 'creating';
    // 进入失败路径时的世代：recycle 原地更新条目后对象身份恒等，识别"失败等待期间
    // 条目已被重入 recycle 重建"只能靠世代（见 cleanupFailedStart）
    const generation = entry.generation;
    try {
      await this.docker.run(args, c.startTimeoutMs + 30_000);
    } catch (e) {
      const message = (e as Error).message;
      if (message.includes('already in use')) {
        // 同名容器残留（上次进程退出未清理、或外部创建）：其 agent 连的是已不在的
        // socket server，永远就绪不了。清掉后重试一次。绝不能把冲突吞掉、按本次
        // 挂载清单登记一个与真实容器不符的条目（N-4a 同类缺陷）
        harnessLog('warn', `[container] container name ${name} already in use, removing stale container and retrying`);
        await this.cleanupHalfCreated(name);
        try {
          await this.docker.run(args, c.startTimeoutMs + 30_000);
        } catch (retryError) {
          await this.cleanupFailedStart(userId, entry, generation, name);
          throw new ContainerStartError(`容器创建失败（清理同名容器后重试仍失败）: ${(retryError as Error).message}`);
        }
      } else {
        await this.cleanupFailedStart(userId, entry, generation, name);
        throw new ContainerStartError(`容器创建失败: ${message}`);
      }
    }
    try {
      await this.opts.waitSocketReady(userId, c.startTimeoutMs);
    } catch (e) {
      // 条目必须等 socket 就绪后才登记/固化为 running：先登记会把超时失败固化成
      // "容器就绪"的毒化状态，后续 ensureRunning 直接复用、永不重试（N-3）
      await this.cleanupFailedStart(userId, entry, generation, name);
      throw e;
    }
    entry.state = 'running';
    entry.connectionDead = false;
    entry.startedAtMs = Date.now();
    entry.lastUsedAtMs = Date.now();
    entry.mountedPaths = new Set(mounts.map((m) => m.hostPath));
    entry.sessionWorkspaces = sessionWorkspaces;
    entry.mountFingerprint = mountFingerprint;
    // 新容器（含原地重建）内没有任何 shell/pty/在途任务：忙计数清零，避免旧容器的
    // 陈旧 runtime_status 把 idle 回收挡在门外（新 agent 握手后会补报真实状态）
    entry.inContainer = { shellSessions: 0, pendingTasks: 0, attachedTerminals: 0 };
    entry.generation += 1;
    this.entries.set(userId, entry);
    harnessLog('info', `[container] container ready: user=${userId}, name=${name}`);
    return entry;
  }

  /**
   * 启动失败收尾（N-3 / F-1 / F-2 / G-1）：摘除条目 + rm 半成品容器，让下次 ensureRunning
   * 走完整重建，不把失败固化成"自称就绪"或"卡死 stopped"的条目。
   *
   * 两道校验都是承重的：
   * - 世代校验识别"同一条目对象被原地重建"（recycle 交错，F-1）：世代变了说明在册的
   *   已是新容器，整个清理都必须跳过；
   * - 摘条目后再按"在册条目是本人或无人"决定是否 rm（首建交错，G-1）：容器名按用户
   *   固定，失败等待期间重入方可能另建并登记了新条目（外层条目尚未登记，世代没变），
   *   此时在册容器是它的——rm -f 会摧毁健康容器、把在册条目毒化成"自称 running、
   *   容器已不存在"。新条目首次创建的正常失败（无重入）在册无人，照常清理半成品。
   */
  private async cleanupFailedStart(
    userId: number,
    entry: ContainerEntry,
    generation: number,
    name: string,
  ): Promise<void> {
    if (entry.generation !== generation) {
      harnessLog('warn', `[container] skip cleanup of failed start for user=${userId} (entry rebuilt concurrently)`);
      return;
    }
    this.dropFailedEntry(userId, entry);
    const current = this.entries.get(userId);
    if (current !== undefined && current !== entry) {
      harnessLog('warn', `[container] skip rm of container ${name} for user=${userId} (a newer entry owns it now)`);
      return;
    }
    await this.cleanupHalfCreated(name);
  }

  /**
   * 启动失败后摘除条目（N-3）：只摘自己那一条。身份校验是纵深防御——串行锁 + 世代校验
   * （cleanupFailedStart）已保证不会误删在册新条目，这里再兜一层。
   */
  private dropFailedEntry(userId: number, entry: ContainerEntry): void {
    const current = this.entries.get(userId);
    if (current !== undefined && current !== entry) return;
    this.entries.delete(userId);
  }

  private async dockerStart(entry: ContainerEntry): Promise<void> {
    const c = this.opts.config.container;
    const generation = entry.generation;
    try {
      await this.docker.run(['start', entry.containerName], 30_000);
    } catch (e) {
      // docker start 失败（典型：idle 回收产生的 exited 容器已被 scripts/container-gc.sh
      // 或 docker container prune 清掉，报 No such container）：条目必须摘除，否则卡在
      // stopped——该用户此后每次工具调用都同样失败、永不重建，只有重启后端才恢复（F-2）。
      // 与 createAndStart 失败路径同口径：下次 ensureRunning 走完整 docker run 重建
      await this.cleanupFailedStart(entry.userId, entry, generation, entry.containerName);
      throw new ContainerStartError(`容器启动失败: ${(e as Error).message}`);
    }
    entry.state = 'running';
    entry.connectionDead = false;
    entry.startedAtMs = Date.now();
    entry.lastUsedAtMs = Date.now();
    // 停止期间容器内的 shell/pty/任务已全部消亡：忙计数清零，避免陈旧 runtime_status
    // 把 idle 回收永久挡在门外（新 agent 握手后会补报真实状态）
    entry.inContainer = { shellSessions: 0, pendingTasks: 0, attachedTerminals: 0 };
    try {
      await this.opts.waitSocketReady(entry.userId, c.startTimeoutMs);
    } catch (e) {
      // 与 createAndStart 同口径收尾：重启路径等待超时同样不能留下"自称 running"的
      // 毒化条目（后续 ensureRunning 直接复用、工具调用固定报"未就绪"且要等 idle
      // 回收才可能恢复）。删条目 + rm 容器，下次 ensureRunning 走完整 docker run
      // 重建（新容器带新 agent），根因未除时也每次都有一次自愈机会。
      // 身份/世代校验：条目在失败等待期间已被重建/摘除时，不得删在册新条目、rm 新容器
      await this.cleanupFailedStart(entry.userId, entry, generation, entry.containerName);
      throw e;
    }
    entry.generation += 1;
    harnessLog('info', `[container] container restarted: user=${entry.userId}`);
  }

  /** idle 回收只 stop 不 rm：挂载数据保留（§5.2）。 */
  private async stopContainer(entry: ContainerEntry, opts: { force: boolean }): Promise<void> {
    // 陈旧条目防护：await 期间条目已被重建（recycle 原地更新、generation +1）或已从
    // 注册表摘除时，旧操作的 docker stop 会按容器名误伤新容器，必须直接跳过。
    // requestShutdown 是异步通知，其回调里可能同步触发 recycle（重入），因此通知
    // 前后各校验一次
    const generation = entry.generation;
    if (!this.isLive(entry, generation)) return;
    entry.state = 'stopped';
    if (!opts.force) {
      // 回收前通知：容器内有机会拒绝/收尾（§5.3.1 对策 3）。无响应时按 idle 判定结果照常停。
      await this.opts.requestShutdown(entry.userId);
      if (!this.isLive(entry, generation)) return;
    }
    await this.docker.run(['stop', '-t', '10', entry.containerName], 30_000).catch((e) => {
      harnessLog('warn', `[container] docker stop failed for user=${entry.userId}: ${(e as Error).message}`);
    });
    harnessLog('info', `[container] container stopped: user=${entry.userId}`);
  }

  /** 条目是否仍是"本次操作面对的那个"：在册且世代未变（await 之后调用）。 */
  private isLive(entry: ContainerEntry, generation: number): boolean {
    if (this.entries.get(entry.userId) === entry && entry.generation === generation) return true;
    harnessLog('warn', `[container] skipping stale container op for user=${entry.userId} (entry replaced or reaped)`);
    return false;
  }

  private async cleanupHalfCreated(name: string): Promise<void> {
    await this.docker.run(['rm', '-f', name], 15_000).catch(() => undefined);
  }
}

function isWritable(dir: string): boolean {
  try {
    const probe = path.join(dir, `.mao-write-probe-${process.pid}`);
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}
