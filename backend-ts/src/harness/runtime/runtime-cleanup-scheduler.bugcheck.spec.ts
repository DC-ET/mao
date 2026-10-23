import { describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeCleanupScheduler } from './runtime-cleanup-scheduler.js';

/**
 * BUGCHECK（审查新增，非产品代码）：runtime 清理调度器扫描到「取不到 stat」的条目时
 * 直接抛异常，整轮清理失败，并因 `start()` 里 `void this.runCleanup()` 无人接 catch
 * 变成 unhandledRejection（Node ≥15 默认终止进程）→ 后端进程崩溃。
 *
 * 根因：`runtime-cleanup-scheduler.ts` 的 `runCleanup()` 对 runtime 目录下的每一层
 * 目录直接 `statSync()`，没有 try/catch：
 *
 * ```ts
 * const userDirs = this.safeReadDir(this.runtimeRoot);
 * for (const userId of userDirs) {
 *   const userRoot = resolve(this.runtimeRoot, userId);
 *   if (!statSync(userRoot).isDirectory()) continue;   // ← 抛 ENOENT 即中断整轮
 *   ...
 *   if (!statSync(sessionRoot).isDirectory()) continue; // ← 同上
 * }
 * ```
 *
 * 生产触发路径：删除会话会调 `app-utils.ts` 的 `runtimeSessionCleanup()` →
 * `rmSync(runtime/<uid>/<sid>, {recursive:true})`，与定时扫描并发时，
 * 扫描刚 `readdirSync` 出来的会话目录随即被删掉 → `statSync` 抛 ENOENT。
 * 本用例用「悬空符号链接」复现同一条 statSync 抛 ENOENT 的路径（stat 会跟随软链，
 * 目标不存在即抛 ENOENT），保证用例稳定、可复现。
 *
 * 断言按「本应如此」书写：单个条目取不到 stat 时应跳过，不应让整轮清理 reject。
 * 当前源码下断言失败即证明 BUG 真实存在。
 */

describe('BUGCHECK runtime cleanup scheduler must survive entries that vanish mid-scan', () => {
  it('does not reject when a scanned session entry cannot be stat-ed (ENOENT)', async () => {
    const root = join(tmpdir(), `mao-runtime-cleanup-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(root, '7'), { recursive: true });
    // 悬空软链：statSync 跟随软链 → 目标不存在 → 抛 ENOENT
    symlinkSync(join(root, 'does-not-exist'), join(root, '7', '5'));

    const scheduler = new RuntimeCleanupScheduler(root, {
      intervalMs: 60_000,
      shellOutputMaxAgeDays: 7,
      cleanupSkills: true,
    });

    let error: unknown = null;
    try {
      await scheduler.runCleanup();
    } catch (e) {
      error = e;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    expect(error).toBeNull();
  });
});
