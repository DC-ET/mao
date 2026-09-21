import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SkillSyncService } from './skill-sync-service.js';
import { RuntimeDataResolver } from '../runtime/runtime-data-resolver.js';
import { useTmpDir } from '../../testing/tmp-dir.js';

function makeService(root: string, systemFolder: string, userDir = join(root, 'users')) {
  const runtime = RuntimeDataResolver.forTest(join(root, 'runtime'), join(root, 'home'));
  const skillLoader = {
    getAllNames: () => ['java'],
    getSkillFolder: (name: string) => (name === 'java' ? systemFolder : null),
  };
  const svc = new SkillSyncService(skillLoader as never, { addAllowedRoot: vi.fn() } as never, runtime, userDir);
  return { runtime, svc };
}

function makeSystemSkill(root: string, body = 'body'): string {
  const systemFolder = join(root, 'system', 'java');
  mkdirSync(systemFolder, { recursive: true });
  writeFileSync(join(systemFolder, 'SKILL.md'), `---\nname: java\ndescription: Java\n---\n${body}`);
  return systemFolder;
}

describe('SkillSyncService', () => {
  it('syncs system and user skills then lists documents', async () => {
    const root = useTmpDir('skills-');
    const systemFolder = makeSystemSkill(root);
    const userDir = join(root, 'users');
    mkdirSync(join(userDir, '7', 'mine'), { recursive: true });
    writeFileSync(join(userDir, '7', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: Mine\n---\nuser');
    const { runtime, svc } = makeService(root, systemFolder, userDir);
    await svc.syncToSession({ id: 2, name: 'a', systemPrompt: 'p', skillNames: '["java"]' }, 7, 9);
    expect(svc.getUserSkillNames(7)).toEqual(['mine']);
    expect(svc.getUserSkillDocuments(7)[0].name).toBe('mine');
    expect(svc.resolveSkillNames({ skillNames: '["java"]' } as never)).toEqual(['java']);
    expect(svc.resolveSkillNames({ skillNames: '' } as never)).toEqual([]);
    expect(svc.resolveSkillNames({ skillNames: '{' } as never)).toEqual([]);
    await svc.syncToSession({ id: 2, name: 'a', systemPrompt: 'p' }, null, 9);
  });

  it('links each skill to its source folder instead of copying', async () => {
    const root = useTmpDir('skills-link-');
    const systemFolder = makeSystemSkill(root);
    const { runtime, svc } = makeService(root, systemFolder);
    await svc.syncToSession({ id: 6, name: 'a', systemPrompt: 'p', skillNames: '["java"]' }, 7, 31);

    const target = join(runtime.resolveSkillsDir(7, 31), 'java');
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(resolve(join(target, '..'), readlinkSync(target))).toBe(resolve(systemFolder));
  });

  it('serves the latest source content through the link without re-syncing', async () => {
    const root = useTmpDir('skills-live-');
    const systemFolder = makeSystemSkill(root);
    mkdirSync(join(systemFolder, 'scripts'), { recursive: true });
    writeFileSync(join(systemFolder, 'scripts', 'run.sh'), 'echo v1');
    const { runtime, svc } = makeService(root, systemFolder);
    const agent = { id: 4, name: 'a', systemPrompt: 'p', skillNames: '["java"]' };
    await svc.syncToSession(agent, 7, 13);
    const linked = join(runtime.resolveSkillsDir(7, 13), 'java', 'scripts', 'run.sh');
    expect(readFileSync(linked, 'utf8')).toBe('echo v1');

    // 链接指向源目录，源变更立即生效，无需再次同步
    writeFileSync(join(systemFolder, 'scripts', 'run.sh'), 'echo v2');
    expect(readFileSync(linked, 'utf8')).toBe('echo v2');
  });

  it('recreates the link after the runtime skills dir was cleaned up, keeping the source intact', async () => {
    const root = useTmpDir('skills-cleaned-');
    const systemFolder = makeSystemSkill(root);
    const { runtime, svc } = makeService(root, systemFolder);
    const agent = { id: 5, name: 'a', systemPrompt: 'p', skillNames: '["java"]' };
    await svc.syncToSession(agent, 7, 21);
    const target = join(runtime.resolveSkillsDir(7, 21), 'java');
    expect(existsSync(target)).toBe(true);

    // 模拟定时清理删除 runtime 下的 skills 目录
    rmSync(runtime.resolveSkillsDir(7, 21), { recursive: true, force: true });
    expect(existsSync(target)).toBe(false);
    // 源目录不受清理影响，已全局安装的 CLI 不会因链接消失而失效
    expect(existsSync(join(systemFolder, 'SKILL.md'))).toBe(true);

    await svc.syncToSession(agent, 7, 21);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toContain('name: java');
  });

  it('replaces a legacy real directory with a symlink', async () => {
    const root = useTmpDir('skills-legacy-');
    const systemFolder = makeSystemSkill(root);
    const { runtime, svc } = makeService(root, systemFolder);
    const target = join(runtime.resolveSkillsDir(7, 41), 'java');
    // 旧版本留下的是实体副本目录
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'SKILL.md'), 'stale copy');

    await svc.syncToSession({ id: 7, name: 'a', systemPrompt: 'p', skillNames: '["java"]' }, 7, 41);
    expect(lstatSync(target).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toContain('name: java');
  });

  it('fixes a dangling or wrong symlink', async () => {
    const root = useTmpDir('skills-dangling-');
    const systemFolder = makeSystemSkill(root);
    const { runtime, svc } = makeService(root, systemFolder);
    const skillsDir = runtime.resolveSkillsDir(7, 51);
    const target = join(skillsDir, 'java');
    mkdirSync(skillsDir, { recursive: true });
    symlinkSync(join(root, 'gone'), target, 'dir');

    await svc.syncToSession({ id: 8, name: 'a', systemPrompt: 'p', skillNames: '["java"]' }, 7, 51);
    expect(resolve(join(target, '..'), readlinkSync(target))).toBe(resolve(systemFolder));
    expect(existsSync(join(target, 'SKILL.md'))).toBe(true);
  });

  it('reports skills removed from agent config after a prior sync', async () => {
    const root = useTmpDir('skills-removed-');
    const systemFolder = makeSystemSkill(root);
    const userDir = join(root, 'users');
    mkdirSync(join(userDir, '7', 'mine'), { recursive: true });
    writeFileSync(join(userDir, '7', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: Mine\n---\nuser');
    const { svc } = makeService(root, systemFolder, userDir);
    const agent = { id: 3, name: 'a', systemPrompt: 'p', skillNames: '["java"]' };
    await svc.syncToSession(agent, 7, 11);
    expect(svc.getRemovedSkillNames({ ...agent, skillNames: '[]' }, null, 11)).toEqual(expect.arrayContaining(['java', 'mine']));
    expect(svc.getRemovedSkillNames(null, 7, 11)).toEqual([]);
    expect(svc.getRemovedSkillNames(agent, 7, null)).toEqual([]);
  });
});
