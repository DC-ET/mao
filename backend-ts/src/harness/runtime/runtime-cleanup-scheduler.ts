import { readdirSync, statSync, existsSync, rmSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { harnessLog } from '../log.js';

export interface RuntimeCleanupProperties {
  /** 运行扫描间隔（毫秒）。 */
  intervalMs: number;
  /** 清理 shellOutput 下超过多少天的 sh-*.out 文件。<=0 表示不清理该类型。 */
  shellOutputMaxAgeDays: number;
  /** 是否清理各会话目录下的 skills 同步副本。 */
  cleanupSkills: boolean;
}

export interface RuntimeCleanupResult {
  shellOutputRemoved: number;
  skillsRemoved: number;
}

/**
 * 系统级运维调度器：不跑 LLM，直接在服务端定时清理 runtime 目录下的临时数据。
 * 清理范围：
 *   - `runtime/<uid>/<sid>/shellOutput/sh-*.out`（按文件 mtime，超过 shellOutputMaxAgeDays 天）
 *   - `runtime/<uid>/<sid>/skills`（同步副本目录，cleanupSkills 开启时）
 * 该组件与对话式 ScheduledTask 无关，不产生消息、不消耗模型调用。
 */
export class RuntimeCleanupScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly runtimeRoot: string,
    private readonly properties: RuntimeCleanupProperties,
    /** 可选的活跃会话判定：返回 true 时跳过该会话的 skills 清理，避免清理正在运行会话的依赖。 */
    private readonly isSessionActive?: (userId: number, sessionId: number) => boolean | Promise<boolean>,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.runCleanup(); }, this.properties.intervalMs);
    harnessLog('info', `Runtime cleanup scheduler started (interval=${this.properties.intervalMs}ms, root=${this.runtimeRoot})`);
    // 启动时立刻跑一轮，避免首轮等待时间过长
    void this.runCleanup();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async runCleanup(): Promise<RuntimeCleanupResult> {
    if (this.running || !existsSync(this.runtimeRoot)) {
      return { shellOutputRemoved: 0, skillsRemoved: 0 };
    }
    this.running = true;
    try {
      const result: RuntimeCleanupResult = { shellOutputRemoved: 0, skillsRemoved: 0 };
      const userDirs = this.safeReadDir(this.runtimeRoot);
      for (const userId of userDirs) {
        const userRoot = resolve(this.runtimeRoot, userId);
        if (!statSync(userRoot).isDirectory()) continue;
        const sessionDirs = this.safeReadDir(userRoot);
        for (const sessionId of sessionDirs) {
          const sessionRoot = resolve(userRoot, sessionId);
          if (!statSync(sessionRoot).isDirectory()) continue;
          if (this.properties.shellOutputMaxAgeDays > 0) {
            result.shellOutputRemoved += this.cleanupShellOutput(sessionRoot);
          }
          if (this.properties.cleanupSkills) {
            const skillsDir = join(sessionRoot, 'skills');
            if (existsSync(skillsDir) && !(await this.isSessionActive?.(Number(userId), Number(sessionId)))) {
              this.removeDir(skillsDir);
              result.skillsRemoved += 1;
            }
          }
        }
      }
      this.logResult(result);
      return result;
    } finally {
      this.running = false;
    }
  }

  private cleanupShellOutput(sessionRoot: string): number {
    const outputDir = join(sessionRoot, 'shellOutput');
    if (!existsSync(outputDir)) return 0;
    let removed = 0;
    const cutoffMs = Date.now() - this.properties.shellOutputMaxAgeDays * 24 * 3600_000;
    for (const name of this.safeReadDir(outputDir)) {
      if (!name.startsWith('sh-') || !name.endsWith('.out')) continue;
      const filePath = join(outputDir, name);
      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) continue;
        if (stat.mtimeMs < cutoffMs) {
          unlinkSync(filePath);
          removed += 1;
        }
      } catch {
        /* 忽略单个文件读取失败，continue */
      }
    }
    return removed;
  }

  private removeDir(dir: string): void {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (e) {
      harnessLog('warn', `Failed to remove skills dir ${dir}: ${(e as Error).message}`);
    }
  }

  private safeReadDir(dir: string): string[] {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  }

  private logResult(result: RuntimeCleanupResult): void {
    if (result.shellOutputRemoved === 0 && result.skillsRemoved === 0) return;
    harnessLog('info', `Runtime cleanup: removed ${result.shellOutputRemoved} shell output files, ${result.skillsRemoved} skills dirs (root=${this.runtimeRoot})`);
  }
}
