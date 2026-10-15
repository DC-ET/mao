import { execFile as execFileCb } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
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
  private readonly creating = new Map<number, Promise<ContainerEntry>>();
  private readonly planner: ContainerMountPlanner;
  private idleTimer: NodeJS.Timeout | null = null;

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
    harnessLog('info', `[container] precheck OK: image=${c.image}`);
  }

  getEntry(userId: number): ContainerEntry | undefined {
    return this.entries.get(userId);
  }

  /**
   * ensureRunning：不存在则创建并等待就绪；stopped 则 start；running 直接复用。
   * 并发调用合并为一次创建。
   *
   * requiredWorkspace：本次调用所属会话的工作区（N-2）。docker 挂载清单在 docker run
   * 时定型，运行中容器无法新增挂载：工作区不在已挂载集合内时重建容器（旧容器内既有
   * shell/pty/在途任务随重建丢失，这是把新通道会话工作区纳入容器的必要代价，仅在
   * 用户新建该类会话的首次调用时发生）。web 会话工作区在 {workspaceRoot}/{userId}
   * 之下，命中已挂载集合，不会触发重建。
   */
  async ensureRunning(userId: number, requiredWorkspace?: string | null): Promise<ContainerEntry> {
    const inFlight = this.creating.get(userId);
    if (inFlight) {
      // 并发创建合并：本次调用无法把 requiredWorkspace 并入已发出的 docker run，
      // 等创建完成后再按挂载检查决定是否重建
      const entry = await inFlight;
      return this.ensureWorkspaceMounted(entry, requiredWorkspace);
    }
    const entry = this.entries.get(userId);
    if (entry) {
      if (entry.state === 'running' && !entry.connectionDead) {
        entry.lastUsedAtMs = Date.now();
        return this.ensureWorkspaceMounted(entry, requiredWorkspace);
      }
      if (entry.state === 'stopped' && !entry.connectionDead) {
        const desired = await this.sessionWorkspaces(userId);
        if (this.hasUnmountedWorkspace(entry, desired)) {
          // 停止期间（idle 回收后）新增的通道会话工作区只能随完整重建挂入：
          // docker start 复用创建时的挂载清单，带不上新目录
          harnessLog('warn', `[container] recreating container for user=${userId} (new session workspaces while stopped)`);
          await this.cleanupHalfCreated(entry.containerName);
          this.entries.delete(userId);
        } else {
          entry.lastUsedAtMs = Date.now();
          await this.dockerStart(entry);
          return this.ensureWorkspaceMounted(entry, requiredWorkspace);
        }
      } else {
        // connectionDead（容器内 agent 失联）或状态异常：停止旧容器后重建
        harnessLog('warn', `[container] rebuilding container for user=${userId} (state=${entry.state}, dead=${entry.connectionDead})`);
        await this.stopContainer(entry, { force: true });
        this.entries.delete(userId);
      }
    }
    const create = this.createAndStart(userId, requiredWorkspace ? [requiredWorkspace] : [])
      .finally(() => this.creating.delete(userId));
    this.creating.set(userId, create);
    const created = await create;
    return this.ensureWorkspaceMounted(created, requiredWorkspace);
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
    await this.stopContainer(entry, { force: true });
    await this.cleanupHalfCreated(entry.containerName);
    this.entries.delete(entry.userId);
    // 保留此前已挂载的会话工作区，只增量并入新工作区
    const extras = [...new Set([...entry.sessionWorkspaces, target])];
    const create = this.createAndStart(entry.userId, extras).finally(() => this.creating.delete(entry.userId));
    this.creating.set(entry.userId, create);
    const created = await create;
    if (!this.isMounted(created, target)) {
      throw new ContainerStartError(
        `会话工作区不在容器可挂载范围内（仅支持每用户工作区与飞书/钉钉通道工作区）: ${target}`,
      );
    }
    return created;
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
    }, IDLE_CHECK_INTERVAL_MS);
    this.idleTimer.unref?.();
  }

  stopIdleLoop(): void {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  /** 应用关闭时停掉本实例管理的容器（数据在挂载卷，下次 start 秒级恢复）。 */
  async stopAllForShutdown(): Promise<void> {
    for (const entry of [...this.entries.values()]) {
      await this.stopContainer(entry, { force: false }).catch(() => undefined);
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
      const busy = entry.inContainer.shellSessions > 0 || entry.inContainer.pendingTasks > 0 || entry.inContainer.attachedTerminals > 0;
      if (busy) continue;
      const idle = Date.now() - entry.lastUsedAtMs > idleMs;
      const expired = Date.now() - entry.startedAtMs > lifetimeMs;
      if (!idle && !expired) continue;
      harnessLog('info', `[container] stopping container user=${entry.userId} (idle=${idle}, lifetimeExpired=${expired})`);
      await this.stopContainer(entry, { force: false });
    }
  }

  private async createAndStart(userId: number, extraWorkspaces: readonly string[] = []): Promise<ContainerEntry> {
    const name = ContainerRegistry.containerName(userId);
    const c = this.opts.config.container;
    // 会话工作区（通道会话）并入挂载清单。统一按通道根过滤：web 会话工作区在
    // {workspaceRoot}/{userId} 之内、由标准清单覆盖，显式传入也不需要附加挂载
    const sessionWorkspaces = [...new Set([
      ...await this.sessionWorkspaces(userId),
      ...extraWorkspaces.map((p) => path.resolve(p)),
    ])].filter((p) => isChannelWorkspace(p, this.opts.workspaceRoot));
    const mounts = this.planner.plan(userId, sessionWorkspaces);
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
      '--tmpfs', `/tmp:size=${c.tmpfsSizeMb}m,mode=1777`,
      // 容器 agent 硬依赖：userId 缺失即 exit(1)；roots 显式注入避免容器内出现第二套路径真相
      '-e', `MAO_CONTAINER_USER_ID=${userId}`,
      '-e', `MAO_CHANNEL_TOKEN=${channelToken}`,
      '-e', `MAO_WORKSPACE_ROOT=${this.opts.workspaceRoot}`,
      '-e', `MAO_RUNTIME_DIR=${this.opts.runtimeDir}`,
      '-e', `MAO_USER_HOME_DIR=${this.opts.userHomeDir}`,
      '-e', `MAO_USER_SKILLS_DIR=${this.opts.userSkillsDir}`,
      ...this.planner.toDockerArgs(mounts),
      // 容器不暴露任何端口：进出只走 Unix socket（§5.2）
      '--restart', 'no',
      c.image,
      'node', path.posix.join(c.distDir, 'harness/container/runtime-agent.js'),
      '--socket', socketPath,
    ];
    // 并发创建靠 docker name 唯一约束兜底：冲突说明对方已在建，改为等待就绪
    try {
      await this.docker.run(args, c.startTimeoutMs + 30_000);
    } catch (e) {
      const message = (e as Error).message;
      if (!message.includes('already in use')) {
        await this.cleanupHalfCreated(name);
        throw new ContainerStartError(`容器创建失败: ${message}`);
      }
    }
    const entry: ContainerEntry = {
      userId,
      containerName: name,
      state: 'running',
      startedAtMs: Date.now(),
      lastUsedAtMs: Date.now(),
      inContainer: { shellSessions: 0, pendingTasks: 0, attachedTerminals: 0 },
      connectionDead: false,
      mountedPaths: new Set(mounts.map((m) => m.hostPath)),
      sessionWorkspaces,
    };
    try {
      await this.opts.waitSocketReady(userId, c.startTimeoutMs);
    } catch (e) {
      // 条目必须等 socket 就绪后才登记为 running：先登记会把超时失败固化成
      // "容器就绪"的毒化状态，后续 ensureRunning 直接复用、永不重试
      this.entries.delete(userId);
      await this.cleanupHalfCreated(name);
      throw e;
    }
    this.entries.set(userId, entry);
    harnessLog('info', `[container] container ready: user=${userId}, name=${name}`);
    return entry;
  }

  private async dockerStart(entry: ContainerEntry): Promise<void> {
    const c = this.opts.config.container;
    await this.docker.run(['start', entry.containerName], 30_000);
    entry.state = 'running';
    entry.connectionDead = false;
    entry.startedAtMs = Date.now();
    entry.lastUsedAtMs = Date.now();
    try {
      await this.opts.waitSocketReady(entry.userId, c.startTimeoutMs);
    } catch (e) {
      // 与 createAndStart 同口径收尾：重启路径等待超时同样不能留下"自称 running"的
      // 毒化条目（后续 ensureRunning 直接复用、工具调用固定报"未就绪"且要等 idle
      // 回收才可能恢复）。删条目 + rm 容器，下次 ensureRunning 走完整 docker run
      // 重建（新容器带新 agent），根因未除时也每次都有一次自愈机会。
      this.entries.delete(entry.userId);
      await this.cleanupHalfCreated(entry.containerName);
      throw e;
    }
    harnessLog('info', `[container] container restarted: user=${entry.userId}`);
  }

  /** idle 回收只 stop 不 rm：挂载数据保留（§5.2）。 */
  private async stopContainer(entry: ContainerEntry, opts: { force: boolean }): Promise<void> {
    // 陈旧条目防护：条目已被 recycle/重建替换（同容器名 mao-user-{userId} 下已是
    // 新容器）时，旧条目的 stop 会误伤新容器（requestShutdown 走当前连接、docker
    // stop 按容器名），必须直接跳过。requestShutdown 是异步通知，期间同样可能发生
    // 替换，因此通知前后各校验一次
    if (this.isStaleEntry(entry)) return;
    entry.state = 'stopped';
    if (!opts.force) {
      // 回收前通知：容器内有机会拒绝/收尾（§5.3.1 对策 3）。无响应时按 idle 判定结果照常停。
      await this.opts.requestShutdown(entry.userId);
      if (this.isStaleEntry(entry)) return;
    }
    await this.docker.run(['stop', '-t', '10', entry.containerName], 30_000).catch((e) => {
      harnessLog('warn', `[container] docker stop failed for user=${entry.userId}: ${(e as Error).message}`);
    });
    harnessLog('info', `[container] container stopped: user=${entry.userId}`);
  }

  private isStaleEntry(entry: ContainerEntry): boolean {
    if (this.entries.get(entry.userId) === entry) return false;
    harnessLog('warn', `[container] skip stopping stale entry for user=${entry.userId} (replaced by a newer container)`);
    return true;
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
