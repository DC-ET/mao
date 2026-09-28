import { harnessLog } from '../log.js';
import { isDrainingInstance, readDeployLock } from './deploy-lock.js';

export interface DeployDrainWatcherDeps {
  runtimeDir: string;
  /** 本实例监听的后端端口。 */
  selfPort: number | null;
  /**
   * 本进程启动时间（秒）。只处理此时间之后开始的部署锁——端口在 9080/9081 间来回切，
   * 残留的 switched 锁其 oldPort 可能正好等于本实例端口，仅凭端口相等会误杀正常实例。
   */
  startedAtSec?: number;
  /**
   * 停机收尾：静默入站 → 等在途执行收尾（有上限）→ 把仍被中断的会话标记为 RESUMING
   * → 关闭资源。调用方需保证幂等（可能被 SIGTERM 路径二次触发）。
   */
  shutdown: () => Promise<void>;
  exit?: (code: number) => void;
  pollIntervalMs?: number;
}

/**
 * 蓝绿发布下，被替换掉的旧实例主动收尾。
 *
 * 背景：切流后 nginx 已指向新实例，但旧实例的飞书/微信/钉钉长连接仍然活着，
 * 发布脚本又要等 drain 定时器（可能漂移几十秒）才 kill 它。这段窗口里到达的消息会被
 * 旧实例接走并开始执行，随后随进程被杀而中断——新实例的启动期恢复扫描早已跑完，
 * 于是会话永久停在 RUNNING，表现为"消息发出去了，一直没响应"。
 *
 * 本监听器轮询 deploy.lock：一旦看到切流完成（status=switched）且自己就是被替换的旧端口，
 * 立即静默入站、等在途执行收尾、把中断会话标记成 RESUMING，然后自行退出。
 * 这样"何时被 kill"不再由外部定时器决定，恢复时序不再依赖 drain 定时器的准确度。
 */
export class DeployDrainWatcher {
  static readonly DEFAULT_POLL_INTERVAL_MS = 5_000;

  private timer: ReturnType<typeof setInterval> | null = null;
  private handling = false;
  private handledStartedAt: number | null = null;

  constructor(private readonly deps: DeployDrainWatcherDeps) {}

  start(): void {
    if (this.timer != null) return;
    const interval = this.deps.pollIntervalMs ?? DeployDrainWatcher.DEFAULT_POLL_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.poll().catch((e) => harnessLog('error', 'Deploy drain poll failed', e));
    }, interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** 单次探测（导出供测试直接调用）。 */
  async poll(): Promise<void> {
    if (this.handling) return;
    const selfPort = this.deps.selfPort;
    if (selfPort == null) return;
    const lock = readDeployLock(this.deps.runtimeDir);
    if (lock == null) return;
    // 只在"切流已成功"且自己正是被替换掉的旧实例时收尾；starting/failed/drained 一律保持原状。
    if (lock.status !== 'switched' || lock.oldPort !== selfPort) return;
    if (this.deps.startedAtSec != null && lock.startedAt < this.deps.startedAtSec) return;
    // 必须能确认流量确实已不在本实例（active-backend-port 已指向新端口）：
    // 端口在 9080/9081 之间来回切，仅凭 status+oldPort 会让残留锁误杀正常实例。
    // 读不到端口文件时同样不动手——误退出会让线上直接不可用，少收尾只是退回脚本 kill 的老路径。
    if (!isDrainingInstance(this.deps.runtimeDir, selfPort)) return;
    if (this.handledStartedAt === lock.startedAt) return;
    this.handledStartedAt = lock.startedAt;
    this.handling = true;
    harnessLog('info', `Deploy switched traffic to port ${lock.newPort}; draining this instance on port ${selfPort}`);
    try {
      await this.deps.shutdown();
    } catch (e) {
      harnessLog('error', 'Graceful drain before shutdown failed', e);
    } finally {
      (this.deps.exit ?? ((code: number) => process.exit(code)))(0);
    }
  }
}
