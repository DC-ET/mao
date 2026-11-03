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
    expect(result).toEqual({ shellOutputRemoved: 0, skillsRemoved: 0, webPageRemoved: 0 });
  });
});
