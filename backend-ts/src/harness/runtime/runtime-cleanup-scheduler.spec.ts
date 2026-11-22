import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RuntimeCleanupScheduler } from './runtime-cleanup-scheduler.js';
import { useTmpDir } from '../../testing/tmp-dir.js';

describe('runtime cleanup scheduler（技能视图 .tmp 残留清理）', () => {
  it('清理 skillViews .tmp 中超过 1 小时的残留，保留新条目', async () => {
    // 技术方案 2026-11-03 §4.7：物化崩溃 / 蓝绿并发留下的 stage 与 .old 目录，
    // 由每轮 runtime 清理顺带兜底；只删超龄条目，不动新条目
    const root = useTmpDir('mao-rtcleanup-');
    const runtimeRoot = join(root, 'runtime');
    const skillViewsDir = join(root, 'skill-views');
    mkdirSync(join(runtimeRoot, '7', '11'), { recursive: true });
    const userTmp = join(skillViewsDir, '.tmp', '7');
    mkdirSync(join(userTmp, 'java-123-abcd'), { recursive: true });
    mkdirSync(join(userTmp, 'java.old-456-efgh'), { recursive: true });
    mkdirSync(join(userTmp, 'java-789-ijkl'), { recursive: true });
    const old = new Date(Date.now() - 2 * 3600_000);
    utimesSync(join(userTmp, 'java-123-abcd'), old, old);
    utimesSync(join(userTmp, 'java.old-456-efgh'), old, old);

    const scheduler = new RuntimeCleanupScheduler(runtimeRoot, {
      intervalMs: 60_000, shellOutputMaxAgeDays: 7, cleanupSkills: false,
    }, undefined, skillViewsDir);
    await scheduler.runCleanup();

    expect(existsSync(join(userTmp, 'java-123-abcd'))).toBe(false);
    expect(existsSync(join(userTmp, 'java.old-456-efgh'))).toBe(false);
    expect(existsSync(join(userTmp, 'java-789-ijkl'))).toBe(true);
  });

  it('不清理活跃视图目录（只处理 .tmp 暂存区）', async () => {
    // 评审修订 §7.1：视图是用户级持久资产（CLI 链接依赖它），即使 mtime 很旧也不能被清理；
    // 清理范围只有 {views}/.tmp 下的崩溃残留
    const root = useTmpDir('mao-rtcleanup-views-');
    const runtimeRoot = join(root, 'runtime');
    const skillViewsDir = join(root, 'skill-views');
    mkdirSync(join(runtimeRoot, '7', '11'), { recursive: true });
    const viewDir = join(skillViewsDir, '7', 'java');
    mkdirSync(viewDir, { recursive: true });
    writeFileSync(join(viewDir, 'SKILL.md'), '---\nname: java\n---\nbody');
    const old = new Date(Date.now() - 48 * 3600_000);
    utimesSync(viewDir, old, old);
    utimesSync(join(viewDir, 'SKILL.md'), old, old);

    const scheduler = new RuntimeCleanupScheduler(runtimeRoot, {
      intervalMs: 60_000, shellOutputMaxAgeDays: 7, cleanupSkills: false,
    }, undefined, skillViewsDir);
    await scheduler.runCleanup();
    expect(existsSync(join(viewDir, 'SKILL.md'))).toBe(true);
  });

  it('未配置 skillViewsDir 时行为不变', async () => {
    const root = useTmpDir('mao-rtcleanup-none-');
    mkdirSync(join(root, 'runtime'), { recursive: true });
    const scheduler = new RuntimeCleanupScheduler(join(root, 'runtime'), {
      intervalMs: 60_000, shellOutputMaxAgeDays: 7, cleanupSkills: false,
    });
    const result = await scheduler.runCleanup();
    expect(result).toEqual({ shellOutputRemoved: 0, skillsRemoved: 0, webPageRemoved: 0, replayRemoved: 0 });
  });

  it('回放 TTL：超龄场目录删除、新鲜场保留（V202，技术方案 2026-11-22 §3.4）', async () => {
    const root = useTmpDir('mao-rtcleanup-replay-');
    const runtimeRoot = join(root, 'runtime');
    const replayRoot = join(runtimeRoot, '7', '11', '.mao-browser', 'replay');
    mkdirSync(join(replayRoot, 'L1000'), { recursive: true });
    mkdirSync(join(replayRoot, 'L2000'), { recursive: true });
    const old = new Date(Date.now() - 8 * 24 * 3600_000);
    utimesSync(join(replayRoot, 'L1000'), old, old);

    const scheduler = new RuntimeCleanupScheduler(runtimeRoot, {
      intervalMs: 60_000, shellOutputMaxAgeDays: 7, cleanupSkills: false,
    }, undefined, undefined, async () => ({ shellOutputMaxAgeDays: 7, browserReplayTtlDays: 7 }));
    const result = await scheduler.runCleanup();

    expect(result.replayRemoved).toBe(1);
    expect(existsSync(join(replayRoot, 'L1000'))).toBe(false);
    expect(existsSync(join(replayRoot, 'L2000'))).toBe(true);
  });

  it('回放 TTL=0 关闭清理；非 L<数字> 目录不碰；活跃会话跳过', async () => {
    const root = useTmpDir('mao-rtcleanup-replay-off-');
    const runtimeRoot = join(root, 'runtime');
    const replayA = join(runtimeRoot, '7', '11', '.mao-browser', 'replay');
    const replayB = join(runtimeRoot, '8', '22', '.mao-browser', 'replay');
    mkdirSync(join(replayA, 'L1000'), { recursive: true });
    mkdirSync(join(replayA, 'not-a-live'), { recursive: true });
    mkdirSync(join(replayB, 'L1000'), { recursive: true });
    const old = new Date(Date.now() - 30 * 24 * 3600_000);
    for (const dir of [join(replayA, 'L1000'), join(replayA, 'not-a-live'), join(replayB, 'L1000')]) utimesSync(dir, old, old);

    // ttl=0：全部保留（含超龄场）
    const offScheduler = new RuntimeCleanupScheduler(runtimeRoot, {
      intervalMs: 60_000, shellOutputMaxAgeDays: 7, cleanupSkills: false,
    }, undefined, undefined, async () => ({ shellOutputMaxAgeDays: 7, browserReplayTtlDays: 0 }));
    await offScheduler.runCleanup();
    expect(existsSync(join(replayA, 'L1000'))).toBe(true);
    expect(existsSync(join(replayB, 'L1000'))).toBe(true);

    // ttl=7 + 会话 8/22 活跃：只清理非活跃的 7/11，且不动非 L<数字> 目录
    const activeScheduler = new RuntimeCleanupScheduler(runtimeRoot, {
      intervalMs: 60_000, shellOutputMaxAgeDays: 7, cleanupSkills: false,
    }, async (_userId, sessionId) => sessionId === 22, undefined,
      async () => ({ shellOutputMaxAgeDays: 7, browserReplayTtlDays: 7 }));
    const result = await activeScheduler.runCleanup();
    expect(result.replayRemoved).toBe(1);
    expect(existsSync(join(replayA, 'L1000'))).toBe(false);
    expect(existsSync(join(replayA, 'not-a-live'))).toBe(true);
    expect(existsSync(join(replayB, 'L1000'))).toBe(true);
  });

  it('TTL resolver 驱动 shellOutput 清理：后台改值下一轮生效', async () => {
    const root = useTmpDir('mao-rtcleanup-ttl-');
    const runtimeRoot = join(root, 'runtime');
    const shellDir = join(runtimeRoot, '7', '11', 'shellOutput');
    mkdirSync(shellDir, { recursive: true });
    const out = join(shellDir, 'sh-1.out');
    writeFileSync(out, 'x');
    // 构造 properties 说 7 天、resolver 说 0 天（后台关闭）→ 不清理
    utimesSync(out, new Date(Date.now() - 30 * 24 * 3600_000), new Date(Date.now() - 30 * 24 * 3600_000));
    const scheduler = new RuntimeCleanupScheduler(runtimeRoot, {
      intervalMs: 60_000, shellOutputMaxAgeDays: 7, cleanupSkills: false,
    }, undefined, undefined, async () => ({ shellOutputMaxAgeDays: 0, browserReplayTtlDays: 0 }));
    const result = await scheduler.runCleanup();
    expect(result.shellOutputRemoved).toBe(0);
    expect(existsSync(out)).toBe(true);
  });

  it('TTL resolver 抛错（DB 抖动）回退启动 properties，不扩大为整轮清理停摆', async () => {
    const root = useTmpDir('mao-rtcleanup-ttl-fail-');
    const runtimeRoot = join(root, 'runtime');
    const shellDir = join(runtimeRoot, '7', '11', 'shellOutput');
    mkdirSync(shellDir, { recursive: true });
    const out = join(shellDir, 'sh-1.out');
    writeFileSync(out, 'x');
    utimesSync(out, new Date(Date.now() - 30 * 24 * 3600_000), new Date(Date.now() - 30 * 24 * 3600_000));
    const scheduler = new RuntimeCleanupScheduler(runtimeRoot, {
      intervalMs: 60_000, shellOutputMaxAgeDays: 7, cleanupSkills: false,
    }, undefined, undefined, async () => { throw new Error('db down'); });
    // 回退启动 properties（7 天）→ shell 清理照常执行；回放清理视为关闭
    const result = await scheduler.runCleanup();
    expect(result.shellOutputRemoved).toBe(1);
    expect(existsSync(out)).toBe(false);
    expect(result.replayRemoved).toBe(0);
  });
});
