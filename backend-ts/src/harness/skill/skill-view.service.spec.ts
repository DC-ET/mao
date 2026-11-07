import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanupStaleSkillViewTmp, SkillViewService } from './skill-view.service.js';
import { useTmpDir } from '../../testing/tmp-dir.js';

function makeSkillSource(root: string, name = 'java', body = 'body'): string {
  const folder = join(root, 'skills', name);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: Java\n---\n${body}`);
  return folder;
}

describe('SkillViewService（技能视图物化）', () => {
  it('首次物化生成视图与 .meta，指纹未变时短路不重建', async () => {
    const root = useTmpDir('skill-view-');
    const source = makeSkillSource(root);
    const svc = new SkillViewService(join(root, 'skill-views'));

    const view = await svc.ensureView(7, 5, 'java', source);
    expect(view).toBe(join(root, 'skill-views', '7', '5', 'java'));
    expect(readFileSync(join(view!, 'SKILL.md'), 'utf8')).toContain('name: java');
    // .meta 落在挂载根之外（{views}/.meta/{u}/{a}/），容器内视图目录只含技能
    const meta = JSON.parse(readFileSync(join(root, 'skill-views', '.meta', '7', '5', 'java.json'), 'utf8'));
    expect(meta.source).toBe(source);
    expect(meta.fingerprint).toMatch(/^\d+-\d+-\d+$/);
    expect(meta.syncedAt).toBeTruthy();
    expect(existsSync(join(view!, '.meta'))).toBe(false);
    expect(readdirSync(join(root, 'skill-views', '7', '5')).sort()).toEqual(['java']);

    // 指纹未变：短路，不重建（视图内手工放置的标记文件仍在）
    writeFileSync(join(view!, '.rebuild-marker'), 'x');
    const again = await svc.ensureView(7, 5, 'java', source);
    expect(again).toBe(view);
    expect(existsSync(join(again!, '.rebuild-marker'))).toBe(true);
  });

  it('源变更触发重建，路径不变、内容更新、旧版本被清理', async () => {
    const root = useTmpDir('skill-view-update-');
    const source = makeSkillSource(root);
    mkdirSync(join(source, 'scripts'), { recursive: true });
    writeFileSync(join(source, 'scripts', 'run.sh'), 'echo v1');
    const svc = new SkillViewService(join(root, 'skill-views'));

    const view = await svc.ensureView(7, 5, 'java', source);
    expect(readFileSync(join(view!, 'scripts', 'run.sh'), 'utf8')).toBe('echo v1');

    // 源更新（改文件）→ 下次 ensureView 重建（视图内旧文件被整体替换）
    writeFileSync(join(view!, '.rebuild-marker'), 'x');
    writeFileSync(join(source, 'scripts', 'run.sh'), 'echo v2');
    // 文件系统时间戳有量化刻度（本机实测 ~4-8ms），同长度改写只靠 mtime 区分；
    // 显式把 mtime 推后，避免两次写落在同一刻度导致指纹不变（生产部署间隔远大于刻度）
    const bumped = new Date(Date.now() + 3000);
    utimesSync(join(source, 'scripts', 'run.sh'), bumped, bumped);
    const updated = await svc.ensureView(7, 5, 'java', source);
    expect(updated).toBe(view); // 路径稳定（软链与 npm bin 链接继续有效）
    expect(existsSync(join(updated!, '.rebuild-marker'))).toBe(false);
    expect(readFileSync(join(updated!, 'scripts', 'run.sh'), 'utf8')).toBe('echo v2');
    // .old 与暂存目录已清理，替换后不残留
    const tmpAgentDir = join(root, 'skill-views', '.tmp', '7', '5');
    expect(existsSync(tmpAgentDir) ? readdirSync(tmpAgentDir) : []).toEqual([]);

    // 增删文件同样触发重建（fileCount 变化）
    writeFileSync(join(source, 'extra.txt'), 'x');
    await svc.ensureView(7, 5, 'java', source);
    expect(existsSync(join(view!, 'extra.txt'))).toBe(true);
    rmSync(join(source, 'extra.txt'), { force: true });
    await svc.ensureView(7, 5, 'java', source);
    expect(existsSync(join(view!, 'extra.txt'))).toBe(false);
  });

  it('源不存在（技能下线）时清理视图与 meta 并返回 null', async () => {
    const root = useTmpDir('skill-view-gone-');
    const source = makeSkillSource(root);
    const svc = new SkillViewService(join(root, 'skill-views'));
    const view = await svc.ensureView(7, 5, 'java', source);
    expect(existsSync(view!)).toBe(true);

    rmSync(source, { recursive: true, force: true });
    const result = await svc.ensureView(7, 5, 'java', source);
    expect(result).toBeNull();
    expect(existsSync(view!)).toBe(false);
    expect(existsSync(join(root, 'skill-views', '.meta', '7', '5', 'java.json'))).toBe(false);
  });

  it('同用户不同 Agent 的视图互相隔离', async () => {
    const root = useTmpDir('skill-view-agents-');
    const source = makeSkillSource(root);
    const svc = new SkillViewService(join(root, 'skill-views'));
    const viewA = await svc.ensureView(7, 5, 'java', source);
    const viewB = await svc.ensureView(7, 6, 'java', source);
    expect(viewA).toBe(join(root, 'skill-views', '7', '5', 'java'));
    expect(viewB).toBe(join(root, 'skill-views', '7', '6', 'java'));
    expect(existsSync(viewA!)).toBe(true);
    expect(existsSync(viewB!)).toBe(true);
    // 各自独立短路：改 A 视图内标记不影响 B
    writeFileSync(join(viewA!, '.rebuild-marker'), 'x');
    await svc.ensureView(7, 6, 'java', source);
    expect(existsSync(join(viewB!, '.rebuild-marker'))).toBe(false);
    // meta 各自独立
    expect(existsSync(join(root, 'skill-views', '.meta', '7', '5', 'java.json'))).toBe(true);
    expect(existsSync(join(root, 'skill-views', '.meta', '7', '6', 'java.json'))).toBe(true);
  });

  it('技能根本身是软链时 dereference 拷贝', async () => {
    const root = useTmpDir('skill-view-symlink-');
    const real = makeSkillSource(root, 'real-java');
    const linked = join(root, 'skills', 'java');
    symlinkSync(real, linked, 'dir');
    const svc = new SkillViewService(join(root, 'skill-views'));

    const view = await svc.ensureView(7, 5, 'java', linked);
    expect(lstatSync(join(view!, 'SKILL.md')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(view!, 'SKILL.md'), 'utf8')).toContain('name: real-java');
  });

  it('内部软链：技能根内 dereference、越出技能根被跳过', async () => {
    const root = useTmpDir('skill-view-inner-link-');
    const source = makeSkillSource(root);
    const outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    writeFileSync(join(source, 'inside.txt'), 'inside');
    symlinkSync(join(source, 'inside.txt'), join(source, 'in-link.txt'));
    symlinkSync(join(outside, 'secret.txt'), join(source, 'out-link.txt'));
    const svc = new SkillViewService(join(root, 'skill-views'));

    const view = await svc.ensureView(7, 5, 'java', source);
    // 根内软链：按内容拷贝为普通文件
    expect(readFileSync(join(view!, 'in-link.txt'), 'utf8')).toBe('inside');
    expect(lstatSync(join(view!, 'in-link.txt')).isSymbolicLink()).toBe(false);
    // 越出技能根的软链：跳过，不把宿主任意文件带进视图
    expect(existsSync(join(view!, 'out-link.txt'))).toBe(false);
  });

  it('保留文件可执行位', async () => {
    const root = useTmpDir('skill-view-exec-');
    const source = makeSkillSource(root);
    mkdirSync(join(source, 'bin'), { recursive: true });
    const cli = join(source, 'bin', 'cli.js');
    writeFileSync(cli, '#!/usr/bin/env node\n');
    chmodSync(cli, 0o755);
    const svc = new SkillViewService(join(root, 'skill-views'));

    const view = await svc.ensureView(7, 5, 'java', source);
    expect(statSync(join(view!, 'bin', 'cli.js')).mode & 0o777).toBe(0o755);
  });

  it('并发 ensureView 幂等：共享同一次物化、结果一致', async () => {
    const root = useTmpDir('skill-view-concurrent-');
    const source = makeSkillSource(root);
    const svc = new SkillViewService(join(root, 'skill-views'));

    const results = await Promise.all([
      svc.ensureView(7, 5, 'java', source),
      svc.ensureView(7, 5, 'java', source),
      svc.ensureView(7, 5, 'java', source),
    ]);
    expect(new Set(results).size).toBe(1);
    expect(readFileSync(join(results[0]!, 'SKILL.md'), 'utf8')).toContain('name: java');
  });

  it('不同用户的视图互相隔离', async () => {
    const root = useTmpDir('skill-view-users-');
    const source = makeSkillSource(root);
    const svc = new SkillViewService(join(root, 'skill-views'));
    const view7 = await svc.ensureView(7, 5, 'java', source);
    const view8 = await svc.ensureView(8, 5, 'java', source);
    expect(view7).toBe(join(root, 'skill-views', '7', '5', 'java'));
    expect(view8).toBe(join(root, 'skill-views', '8', '5', 'java'));
    expect(existsSync(view8!)).toBe(true);
  });

  it('非法技能名拒绝（防路径穿越）', async () => {
    const root = useTmpDir('skill-view-badname-');
    const svc = new SkillViewService(join(root, 'skill-views'));
    await expect(svc.ensureView(7, 5, '../escape', join(root, 'x'))).rejects.toThrow(/Unsafe skill name/);
    await expect(svc.ensureView(7, 5, 'a/b', join(root, 'x'))).rejects.toThrow(/Unsafe skill name/);
  });

  it('cleanupStaleSkillViewTmp 只清超过阈值的残留（新旧两层布局通吃）', () => {
    const root = useTmpDir('skill-view-tmp-');
    const agentTmp = join(root, '.tmp', '7', '5');
    mkdirSync(join(agentTmp, 'stale-stage'), { recursive: true });
    mkdirSync(join(agentTmp, 'fresh-stage'), { recursive: true });
    const old = new Date(Date.now() - 2 * 3600_000);
    utimesSync(join(agentTmp, 'stale-stage'), old, old);

    const removed = cleanupStaleSkillViewTmp(root);
    expect(removed).toBe(1);
    expect(existsSync(join(agentTmp, 'stale-stage'))).toBe(false);
    expect(existsSync(join(agentTmp, 'fresh-stage'))).toBe(true);

    // 旧布局平铺残留（{tmp}/{u}/ 下的直接条目）一并清理
    const legacyStale = join(root, '.tmp', '8', 'legacy-stage');
    mkdirSync(legacyStale, { recursive: true });
    utimesSync(legacyStale, old, old);
    expect(cleanupStaleSkillViewTmp(root)).toBe(1);
    expect(existsSync(legacyStale)).toBe(false);

    // 非数字 userId 目录不处理（防御未来布局）
    mkdirSync(join(root, '.tmp', 'not-a-user'), { recursive: true });
    expect(cleanupStaleSkillViewTmp(root)).toBe(0);
  });
});
