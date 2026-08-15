import { mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SkillSyncService } from './skill-sync-service.js';
import { RuntimeDataResolver } from '../runtime/runtime-data-resolver.js';

describe('SkillSyncService', () => {
  it('syncs system and user skills then lists documents', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-'));
    const systemFolder = join(root, 'system', 'java');
    mkdirSync(systemFolder, { recursive: true });
    writeFileSync(join(systemFolder, 'SKILL.md'), '---\nname: java\ndescription: Java\n---\nbody');
    const userDir = join(root, 'users');
    mkdirSync(join(userDir, '7', 'mine'), { recursive: true });
    writeFileSync(join(userDir, '7', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: Mine\n---\nuser');
    const runtime = RuntimeDataResolver.forTest(join(root, 'runtime'), join(root, 'home'));
    const skillLoader = {
      getAllNames: () => ['java'],
      getSkillFolder: (name: string) => (name === 'java' ? systemFolder : null),
    };
    const pathSandbox = { addAllowedRoot: vi.fn() };
    const svc = new SkillSyncService(skillLoader as never, pathSandbox as never, runtime, userDir);
    await svc.syncToSession({ id: 2, name: 'a', systemPrompt: 'p', skillNames: '["java"]' }, 7, 9);
    expect(pathSandbox.addAllowedRoot).toHaveBeenCalled();
    expect(svc.getUserSkillNames(7)).toEqual(['mine']);
    expect(svc.getUserSkillDocuments(7)[0].name).toBe('mine');
    expect(svc.resolveSkillNames({ skillNames: '["java"]' } as never)).toEqual(['java']);
    expect(svc.resolveSkillNames({ skillNames: '' } as never)).toEqual(['java']);
    expect(svc.resolveSkillNames({ skillNames: '{' } as never)).toEqual(['java']);
    await svc.syncToSession({ id: 2, name: 'a', systemPrompt: 'p' }, null, 9);
  });

  it('re-syncs when only a nested file changed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-nested-'));
    const systemFolder = join(root, 'system', 'java');
    mkdirSync(join(systemFolder, 'scripts'), { recursive: true });
    writeFileSync(join(systemFolder, 'SKILL.md'), '---\nname: java\ndescription: Java\n---\nbody');
    writeFileSync(join(systemFolder, 'scripts', 'run.sh'), 'echo v1');
    const runtime = RuntimeDataResolver.forTest(join(root, 'runtime'), join(root, 'home'));
    const skillLoader = {
      getAllNames: () => ['java'],
      getSkillFolder: (name: string) => (name === 'java' ? systemFolder : null),
    };
    const svc = new SkillSyncService(skillLoader as never, { addAllowedRoot: vi.fn() } as never, runtime, join(root, 'users'));
    const agent = { id: 4, name: 'a', systemPrompt: 'p', skillNames: '["java"]' };
    await svc.syncToSession(agent, 7, 13);
    const synced = join(runtime.resolveSkillsDir(7, 13), 'java', 'scripts', 'run.sh');
    expect(readFileSync(synced, 'utf8')).toBe('echo v1');

    // 只改嵌套文件，顶层目录 mtime 不变
    const future = new Date(Date.now() + 5000);
    writeFileSync(join(systemFolder, 'scripts', 'run.sh'), 'echo v2');
    utimesSync(join(systemFolder, 'scripts', 'run.sh'), future, future);
    await svc.syncToSession(agent, 7, 13);
    expect(readFileSync(synced, 'utf8')).toBe('echo v2');
  });

  it('reports skills removed from agent config after a prior sync', async () => {
    const root = mkdtempSync(join(tmpdir(), 'skills-removed-'));
    const systemFolder = join(root, 'system', 'java');
    mkdirSync(systemFolder, { recursive: true });
    writeFileSync(join(systemFolder, 'SKILL.md'), '---\nname: java\ndescription: Java\n---\nbody');
    const userDir = join(root, 'users');
    mkdirSync(join(userDir, '7', 'mine'), { recursive: true });
    writeFileSync(join(userDir, '7', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: Mine\n---\nuser');
    const runtime = RuntimeDataResolver.forTest(join(root, 'runtime'), join(root, 'home'));
    const skillLoader = {
      getAllNames: () => ['java'],
      getSkillFolder: (name: string) => (name === 'java' ? systemFolder : null),
    };
    const svc = new SkillSyncService(skillLoader as never, { addAllowedRoot: vi.fn() } as never, runtime, userDir);
    const agent = { id: 3, name: 'a', systemPrompt: 'p', skillNames: '["java"]' };
    await svc.syncToSession(agent, 7, 11);
    expect(svc.getRemovedSkillNames({ ...agent, skillNames: '[]' }, null, 11)).toEqual(expect.arrayContaining(['java', 'mine']));
    expect(svc.getRemovedSkillNames(null, 7, 11)).toEqual([]);
    expect(svc.getRemovedSkillNames(agent, 7, null)).toEqual([]);
  });
});
