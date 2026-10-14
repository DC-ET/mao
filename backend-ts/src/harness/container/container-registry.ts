import { execFile as execFileCb } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { harnessLog } from '../log.js';
import type { CloudRuntimeConfig } from '../../config/app-config.js';
import { ContainerMountPlanner, type ContainerMount } from './container-mount-planner.js';
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
  /** 容器启动命令等待 socket 就绪时轮询连接的回调。 */
  waitSocketReady(userId: number, timeoutMs: number): Promise<void>;
  /** 停止前发 shutdown 帧让容器收尾（§5.3.1 对策 3）。返回 false 表示容器无响应。 */
  requestShutdown(userId: number): Promise<boolean>;
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

  /** ensureRunning：不存在则创建并等待就绪；stopped 则 start；running 直接复用。并发调用合并为一次创建。 */
  async ensureRunning(userId: number): Promise<ContainerEntry> {
    const inFlight = this.creating.get(userId);
    if (inFlight) return inFlight;
    const entry = this.entries.get(userId);
    if (entry) {
      if (entry.state === 'running' && !entry.connectionDead) {
        entry.lastUsedAtMs = Date.now();
        return entry;
      }
      if (entry.state === 'stopped' && !entry.connectionDead) {
        entry.lastUsedAtMs = Date.now();
        await this.dockerStart(entry);
        return entry;
      }
      // connectionDead（容器内 agent 失联）或状态异常：停止旧容器后重建
      harnessLog('warn', `[container] rebuilding container for user=${userId} (state=${entry.state}, dead=${entry.connectionDead})`);
      await this.stopContainer(entry, { force: true });
      this.entries.delete(userId);
    }
    const create = this.createAndStart(userId).finally(() => this.creating.delete(userId));
    this.creating.set(userId, create);
    return create;
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

  private async createAndStart(userId: number): Promise<ContainerEntry> {
    const name = ContainerRegistry.containerName(userId);
    const c = this.opts.config.container;
    const mounts = this.planner.plan(userId);
    this.planner.auditLog(userId, mounts);
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
      ...this.planner.toDockerArgs(mounts),
      // 容器不暴露任何端口：进出只走 Unix socket（§5.2）
      '--restart', 'no',
      c.image,
      'node', path.posix.join(c.distDir, 'harness/container/runtime-agent.js'),
      '--socket', path.join(c.channelDir, String(userId), 'runtime.sock'),
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
    };
    this.entries.set(userId, entry);
    await this.opts.waitSocketReady(userId, c.startTimeoutMs);
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
    await this.opts.waitSocketReady(entry.userId, c.startTimeoutMs);
    harnessLog('info', `[container] container restarted: user=${entry.userId}`);
  }

  /** idle 回收只 stop 不 rm：挂载数据保留（§5.2）。 */
  private async stopContainer(entry: ContainerEntry, opts: { force: boolean }): Promise<void> {
    entry.state = 'stopped';
    if (!opts.force) {
      // 回收前通知：容器内有机会拒绝/收尾（§5.3.1 对策 3）。无响应时按 idle 判定结果照常停。
      await this.opts.requestShutdown(entry.userId);
    }
    await this.docker.run(['stop', '-t', '10', entry.containerName], 30_000).catch((e) => {
      harnessLog('warn', `[container] docker stop failed for user=${entry.userId}: ${(e as Error).message}`);
    });
    harnessLog('info', `[container] container stopped: user=${entry.userId}`);
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
