import { readdirSync, statSync, existsSync, rmSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { harnessLog } from '../log.js';
import { cleanupStaleSkillViewTmp } from '../skill/skill-view.service.js';

export interface RuntimeCleanupProperties {
  /** 运行扫描间隔（毫秒）。 */
  intervalMs: number;
  /** 清理 shellOutput 下超过多少天的 sh-*.out 文件。<=0 表示不清理该类型。 */
  shellOutputMaxAgeDays: number;
  /** 是否清理各会话目录下的 skills 同步副本。 */
  cleanupSkills: boolean;
}

/** 每轮清理开始时现读的时效值（V202 后台化：管理后台改值下一轮即生效，无需重启）。 */
export interface RuntimeCleanupTtls {
  /** shellOutput / webPages 文件保留天数；0=不清理。 */
  shellOutputMaxAgeDays: number;
  /** 浏览器直播回放场目录保留天数；0=不清理（仍随会话删除级联）。 */
  browserReplayTtlDays: number;
}

export interface RuntimeCleanupResult {
  shellOutputRemoved: number;
  skillsRemoved: number;
  webPageRemoved: number;
  replayRemoved: number;
}

/**
 * 系统级运维调度器：不跑 LLM，直接在服务端定时清理 runtime 目录下的临时数据。
 * 清理范围：
 *   - `runtime/<uid>/<sid>/shellOutput/sh-*.out`（按文件 mtime，超过 shellOutputMaxAgeDays 天）
 *   - `runtime/<uid>/<sid>/webPages/*.md`（网页全文落盘，与 shell 输出同周期）
 *   - `runtime/<uid>/<sid>/skills`（同步副本目录，cleanupSkills 开启时）
 *   - `runtime/<uid>/<sid>/.mao-browser/replay/<liveId>`（浏览器直播回放场目录，V202；
 *     TTL 后台可调，活跃会话跳过，防误删正在写入的场）
 * 该组件与对话式 ScheduledTask 无关，不产生消息、不消耗模型调用。
 */
export class RuntimeCleanupScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly runtimeRoot: string,
    private readonly properties: RuntimeCleanupProperties,
    /** 可选的活跃会话判定：返回 true 时跳过该会话的 skills / 回放清理，避免清理正在运行会话的依赖。 */
    private readonly isSessionActive?: (userId: number, sessionId: number) => boolean | Promise<boolean>,
    /**
     * 技能视图根（SKILL_VIEWS_DIR，可省略）：提供时每轮清理顺带删除 .tmp 暂存区
     * 超过 1 小时的物化残留（技术方案 2026-11-03 §4.7）。
     */
    private readonly skillViewsDir?: string,
    /**
     * 每轮现读时效（V202 后台化）：返回 null / 未注入时回落构造 properties（回放清理视为关闭）。
     * resolver 抛错（DB 抖动）同样回落构造 properties，不影响既有清理步骤（runCleanup 内兜底）。
     */
    private readonly ttlResolver?: () => Promise<RuntimeCleanupTtls | null>,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { this.runCleanupSafely(); }, this.properties.intervalMs);
    harnessLog('info', `Runtime cleanup scheduler started (interval=${this.properties.intervalMs}ms, root=${this.runtimeRoot})`);
    // 启动时立刻跑一轮，避免首轮等待时间过长
    this.runCleanupSafely();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 无人 await 的调用点（定时回调、启动即跑）统一走这里：runCleanup 若再抛异常，
   * 只落 warn 日志，不能变成 unhandledRejection 把进程带崩。
   */
  private runCleanupSafely(): void {
    this.runCleanup().catch((e) => {
      harnessLog('warn', `Runtime cleanup run failed: ${(e as Error).message}`);
    });
  }

  async runCleanup(): Promise<RuntimeCleanupResult> {
    if (this.running || !existsSync(this.runtimeRoot)) {
      return { shellOutputRemoved: 0, skillsRemoved: 0, webPageRemoved: 0, replayRemoved: 0 };
    }
    this.running = true;
    try {
      const result: RuntimeCleanupResult = { shellOutputRemoved: 0, skillsRemoved: 0, webPageRemoved: 0, replayRemoved: 0 };
      // 每轮现读时效（V202 后台化）：后台改值下一轮即生效。resolver 失败（DB 抖动）回退
      // 启动 properties（回放清理视为关闭），不能让 TTL 读取失败扩大为整轮清理停摆
      let ttls: RuntimeCleanupTtls = {
        shellOutputMaxAgeDays: this.properties.shellOutputMaxAgeDays,
        browserReplayTtlDays: 0,
      };
      try {
        ttls = (await this.ttlResolver?.()) ?? ttls;
      } catch (e) {
        harnessLog('warn', `Runtime cleanup: ttl resolve failed, fallback to startup properties: ${(e as Error).message}`);
      }
      // 技能视图暂存区残留（>1h）：物化进程崩溃 / 蓝绿并发留下的 stage 与 .old 目录
      if (this.skillViewsDir != null) {
        try {
          const removed = cleanupStaleSkillViewTmp(this.skillViewsDir);
          if (removed > 0) harnessLog('info', `Runtime cleanup: removed ${removed} stale skill-view tmp entries`);
        } catch (e) {
          harnessLog('warn', `Runtime cleanup: skill-view tmp cleanup failed: ${(e as Error).message}`);
        }
      }
      const userDirs = this.safeReadDir(this.runtimeRoot);
      for (const userId of userDirs) {
        const userRoot = resolve(this.runtimeRoot, userId);
        if (!this.isDirectory(userRoot)) continue;
        const sessionDirs = this.safeReadDir(userRoot);
        for (const sessionId of sessionDirs) {
          const sessionRoot = resolve(userRoot, sessionId);
          if (!this.isDirectory(sessionRoot)) continue;
          if (ttls.shellOutputMaxAgeDays > 0) {
            result.shellOutputRemoved += this.cleanupAgedFiles(join(sessionRoot, 'shellOutput'), 'sh-', '.out', ttls.shellOutputMaxAgeDays);
            result.webPageRemoved += this.cleanupAgedFiles(join(sessionRoot, 'webPages'), '', '.md', ttls.shellOutputMaxAgeDays);
          }
          if (this.properties.cleanupSkills) {
            const skillsDir = join(sessionRoot, 'skills');
            if (existsSync(skillsDir) && !(await this.isSessionActive?.(Number(userId), Number(sessionId)))) {
              this.removeDir(skillsDir);
              result.skillsRemoved += 1;
            }
          }
          // 浏览器直播回放场目录（V202）：TTL 后台可调；只认纯数字 uid/sid（runtimeSessionCleanup
          // 同口径，防误删 channels 等非用户目录）；活跃会话跳过，防误删正在写入的场
          const replayDir = join(sessionRoot, '.mao-browser', 'replay');
          if (ttls.browserReplayTtlDays > 0 && /^\d+$/.test(userId) && /^\d+$/.test(sessionId) && existsSync(replayDir)) {
            const active = await this.isSessionActive?.(Number(userId), Number(sessionId));
            if (!active) {
              result.replayRemoved += this.cleanupAgedReplayDirs(replayDir, ttls.browserReplayTtlDays);
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

  /** 按 mtime 清理指定目录下带固定前缀/后缀的文件；shellOutput 与 webPages 共用。 */
  private cleanupAgedFiles(dir: string, prefix: string, suffix: string, maxAgeDays: number): number {
    if (!existsSync(dir)) return 0;
    let removed = 0;
    const cutoffMs = Date.now() - maxAgeDays * 24 * 3600_000;
    for (const name of this.safeReadDir(dir)) {
      if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
      const filePath = join(dir, name);
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

  /**
   * 按 mtime 清理回放场目录（<liveId> 一级子目录）。场目录 mtime 随帧/manifest 写入持续更新，
   * 即「最后写入时间」起算 TTL（技术方案 2026-11-22 §3.4）。
   */
  private cleanupAgedReplayDirs(replayDir: string, ttlDays: number): number {
    let removed = 0;
    const cutoffMs = Date.now() - ttlDays * 24 * 3600_000;
    for (const name of this.safeReadDir(replayDir)) {
      if (!/^L\d+$/.test(name)) continue;
      const liveDir = join(replayDir, name);
      try {
        const stat = statSync(liveDir);
        if (!stat.isDirectory()) continue;
        if (stat.mtimeMs < cutoffMs) {
          this.removeDir(liveDir);
          removed += 1;
        }
      } catch {
        /* 单场读取失败跳过，不中断整轮扫描 */
      }
    }
    return removed;
  }

  /**
   * 目录判定带容错：悬空软链、条目被并发删除、权限不足等取不到 stat 时跳过该条目，
   * 不让单个条目中断整轮扫描（与 cleanupAgedFiles / safeReadDir 同口径）。
   */
  private isDirectory(path: string): boolean {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
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
    if (result.shellOutputRemoved === 0 && result.skillsRemoved === 0 && result.webPageRemoved === 0 && result.replayRemoved === 0) return;
    harnessLog('info', `Runtime cleanup: removed ${result.shellOutputRemoved} shell output files, `
      + `${result.webPageRemoved} web page caches, ${result.skillsRemoved} skills dirs, `
      + `${result.replayRemoved} browser replay sessions (root=${this.runtimeRoot})`);
  }
}
