import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { SkillSyncService } from './skill-sync-service.js';
import { SkillViewService } from './skill-view.service.js';
import { RuntimeDataResolver } from '../runtime/runtime-data-resolver.js';
import { useTmpDir } from '../../testing/tmp-dir.js';

function makeService(root: string, systemFolder: string, userDir = join(root, 'users')) {
  const runtime = RuntimeDataResolver.forTest(join(root, 'runtime'), join(root, 'home'), join(root, 'skill-views'));
  const skillLoader = {
    getAllNames: () => ['java'],
    getSkillFolder: (name: string) => (name === 'java' ? systemFolder : null),
  };
  const viewService = new SkillViewService(join(root, 'skill-views'));
  const svc = new SkillSyncService(skillLoader as never, { addAllowedRoot: vi.fn() } as never, runtime, userDir, viewService);
  return { runtime, svc, viewService, viewsRoot: join(root, 'skill-views') };
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

  it('links system skills to the user-level view and user skills to userskills', async () => {
    const root = useTmpDir('skills-link-');
    const systemFolder = makeSystemSkill(root);
    const userDir = join(root, 'users');
    mkdirSync(join(userDir, '7', 'mine'), { recursive: true });
    writeFileSync(join(userDir, '7', 'mine', 'SKILL.md'), '---\nname: mine\ndescription: Mine\n---\nuser');
    const { runtime, svc, viewsRoot } = makeService(root, systemFolder, userDir);
    await svc.syncToSession({ id: 6, name: 'a', systemPrompt: 'p', skillNames: '["java"]' }, 7, 31);

    // 系统技能：软链指向用户级只读视图（不是源目录）
    const systemTarget = join(runtime.resolveSkillsDir(7, 31), 'java');
    expect(lstatSync(systemTarget).isSymbolicLink()).toBe(true);
    expect(resolve(join(systemTarget, '..'), readlinkSync(systemTarget))).toBe(join(viewsRoot, '7', 'java'));
    // 用户技能：软链直指 userskills/{u}/{name}，不经视图
    const userTarget = join(runtime.resolveSkillsDir(7, 31), 'mine');
    expect(lstatSync(userTarget).isSymbolicLink()).toBe(true);
    expect(resolve(join(userTarget, '..'), readlinkSync(userTarget))).toBe(join(userDir, '7', 'mine'));
  });

  it('propagates source updates through the view on the next sync', async () => {
    const root = useTmpDir('skills-live-');
    const systemFolder = makeSystemSkill(root);
    mkdirSync(join(systemFolder, 'scripts'), { recursive: true });
    writeFileSync(join(systemFolder, 'scripts', 'run.sh'), 'echo v1');
    const { runtime, svc } = makeService(root, systemFolder);
    const agent = { id: 4, name: 'a', systemPrompt: 'p', skillNames: '["java"]' };
    await svc.syncToSession(agent, 7, 13);
    const linked = join(runtime.resolveSkillsDir(7, 13), 'java', 'scripts', 'run.sh');
    expect(readFileSync(linked, 'utf8')).toBe('echo v1');

    // 视图是拷贝：源变更需下一轮 sync 重建视图后生效（G4）
    writeFileSync(join(systemFolder, 'scripts', 'run.sh'), 'echo v2');
    // 文件系统时间戳有量化刻度（本机实测 ~4-8ms），同长度改写只靠 mtime 区分；
    // 显式把 mtime 推后，避免两次写落在同一刻度导致指纹不变（生产部署间隔远大于刻度）
    const bumped = new Date(Date.now() + 3000);
    utimesSync(join(systemFolder, 'scripts', 'run.sh'), bumped, bumped);
    expect(readFileSync(linked, 'utf8')).toBe('echo v1');
    await svc.syncToSession(agent, 7, 13);
    expect(readFileSync(linked, 'utf8')).toBe('echo v2');
  });

  it('recreates the link after the runtime skills dir was cleaned up, keeping source and view intact', async () => {
    const root = useTmpDir('skills-cleaned-');
    const systemFolder = makeSystemSkill(root);
    const { runtime, svc } = makeService(root, systemFolder);
    const agent = { id: 5, name: 'a', systemPrompt: 'p', skillNames: '["java"]' };
    await svc.syncToSession(agent, 7, 21);
    const target = join(runtime.resolveSkillsDir(7, 21), 'java');
    expect(existsSync(target)).toBe(true);

    // 模拟定时清理删除 runtime 下的 skills 目录（只删软链，不动视图/源）
    rmSync(runtime.resolveSkillsDir(7, 21), { recursive: true, force: true });
    expect(existsSync(target)).toBe(false);
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

  it('migrates a legacy symlink pointing at the source / fixes a dangling link', async () => {
    const root = useTmpDir('skills-dangling-');
    const systemFolder = makeSystemSkill(root);
    const { runtime, svc, viewsRoot } = makeService(root, systemFolder);
    const skillsDir = runtime.resolveSkillsDir(7, 51);
    const target = join(skillsDir, 'java');
    mkdirSync(skillsDir, { recursive: true });
    // 存量形态：指向源目录的旧软链（换目标天然安全，不会写穿）
    symlinkSync(systemFolder, target, 'dir');

    await svc.syncToSession({ id: 8, name: 'a', systemPrompt: 'p', skillNames: '["java"]' }, 7, 51);
    expect(resolve(join(target, '..'), readlinkSync(target))).toBe(join(viewsRoot, '7', 'java'));
    expect(existsSync(join(target, 'SKILL.md'))).toBe(true);

    // 悬空链接：同样被修复为指向视图
    const skillsDir2 = runtime.resolveSkillsDir(7, 52);
    mkdirSync(skillsDir2, { recursive: true });
    const dangling = join(skillsDir2, 'java');
    symlinkSync(join(root, 'gone'), dangling, 'dir');
    await svc.syncToSession({ id: 8, name: 'a', systemPrompt: 'p', skillNames: '["java"]' }, 7, 52);
    expect(resolve(join(dangling, '..'), readlinkSync(dangling))).toBe(join(viewsRoot, '7', 'java'));
    expect(existsSync(join(dangling, 'SKILL.md'))).toBe(true);
  });

  it('removes the link when the source is gone (skill offline) and cleans the view', async () => {
    const root = useTmpDir('skills-gone-');
    const systemFolder = makeSystemSkill(root);
    const { runtime, svc, viewsRoot } = makeService(root, systemFolder);
    const agent = { id: 9, name: 'a', systemPrompt: 'p', skillNames: '["java"]' };
    await svc.syncToSession(agent, 7, 61);
    const target = join(runtime.resolveSkillsDir(7, 61), 'java');
    expect(existsSync(target)).toBe(true);

    // 源侧技能下线（技能目录被删除），但 loader 缓存仍返回路径 → ensureView 检测源缺失
    rmSync(systemFolder, { recursive: true, force: true });
    const result = await svc.syncToSession(agent, 7, 61);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(viewsRoot, '7', 'java'))).toBe(false);
    // 链接已摘除 → 本轮不可读，必须计入 failed 供调用侧从清单剔除（D7：清单与路径一致）
    expect(result.failed).toContain('java');
  });

  it('degrades by removing the link when materialization fails', async () => {
    const root = useTmpDir('skills-fail-');
    const systemFolder = makeSystemSkill(root);
    const { runtime, svc } = makeService(root, systemFolder);
    const agent = { id: 10, name: 'a', systemPrompt: 'p', skillNames: '["java"]' };
    await svc.syncToSession(agent, 7, 71);
    const target = join(runtime.resolveSkillsDir(7, 71), 'java');
    expect(existsSync(target)).toBe(true);

    // 物化失败（如磁盘满）：本轮不挂载（删除已有链接），不留下指向不存在视图的悬空，
    // 且把失败技能名返回给调用方（§5.3 D7：清单剔除与路径一致）。
    const spy = vi.spyOn(SkillViewService.prototype, 'ensureView').mockRejectedValue(new Error('disk full'));
    try {
      const result = await svc.syncToSession(agent, 7, 71);
      expect(existsSync(target)).toBe(false);
      expect(result.failed).toContain('java');
    } finally {
      spy.mockRestore();
    }
    // 失败解除后下一轮恢复挂载
    const recovered = await svc.syncToSession(agent, 7, 71);
    expect(existsSync(target)).toBe(true);
    expect(recovered.failed).toEqual([]);
  });

  it('syncState 按（agent,user,session）隔离：不同发言者互不清链', async () => {
    const root = useTmpDir('skills-multi-user-');
    const systemFolder = makeSystemSkill(root);
    const userDir = join(root, 'users');
    // 用户 8 有一个个人技能，保证其 merged 非空（空 merged 走早退，不触发清理）
    mkdirSync(join(userDir, '8', 'mine8'), { recursive: true });
    writeFileSync(join(userDir, '8', 'mine8', 'SKILL.md'), '---\nname: mine8\ndescription: Mine8\n---\nu');
    const { svc } = makeService(root, systemFolder, userDir);
    const agent = { id: 12, name: 'a', systemPrompt: 'p', skillNames: '["java"]' };
    const runtimeSkills = (uid: number) => join(root, 'runtime', String(uid), '91', 'skills');

    // 发言者 7 先挂 java
    await svc.syncToSession(agent, 7, 91);
    expect(existsSync(join(runtimeSkills(7), 'java'))).toBe(true);

    // 发言者 8 触发（agent 无系统技能）→ 只挂自己的 mine8，不碰 7 的链接
    await svc.syncToSession({ ...agent, skillNames: '[]' }, 8, 91);
    expect(existsSync(join(runtimeSkills(8), 'mine8'))).toBe(true);
    expect(existsSync(join(runtimeSkills(8), 'java'))).toBe(false);
    expect(existsSync(join(runtimeSkills(7), 'java'))).toBe(true);

    // 8 也挂过 java 后再清空：只清 8 自己，7 不受影响（旧实现按 (agent,session) 键会误清）
    await svc.syncToSession(agent, 8, 91);
    expect(existsSync(join(runtimeSkills(8), 'java'))).toBe(true);
    await svc.syncToSession({ ...agent, skillNames: '[]' }, 8, 91);
    expect(existsSync(join(runtimeSkills(8), 'java'))).toBe(false);
    expect(existsSync(join(runtimeSkills(7), 'java'))).toBe(true);

    // removed 查询同样按身份隔离
    expect(svc.getRemovedSkillNames({ ...agent, skillNames: '[]' }, 7, 91)).toEqual(['java']);
    expect(svc.getRemovedSkillNames({ ...agent, skillNames: '[]' }, 8, 91)).toEqual([]);
  });

  it('does not materialize a deleted source that no agent references (no side effects)', async () => {
    // 评审修订 §7.1：源被删除且无 agent 引用时不触发物化——merged 只含 agent.skillNames，
    // 即使 loader 缓存仍返回已删除技能的路径，也不会为它建视图 / 产生任何副作用
    const root = useTmpDir('skills-ghost-');
    const systemFolder = makeSystemSkill(root);
    const ghostFolder = join(root, 'system', 'ghost'); // 源已删除（不存在）
    const runtime = RuntimeDataResolver.forTest(join(root, 'runtime'), join(root, 'home'), join(root, 'skill-views'));
    const skillLoader = {
      getAllNames: () => ['java'],
      getSkillFolder: (name: string) => (name === 'java' ? systemFolder : name === 'ghost' ? ghostFolder : null),
    };
    const viewService = new SkillViewService(join(root, 'skill-views'));
    const spy = vi.spyOn(viewService, 'ensureView');
    try {
      const svc = new SkillSyncService(skillLoader as never, { addAllowedRoot: vi.fn() } as never, runtime, join(root, 'users'), viewService);
      await svc.syncToSession({ id: 11, name: 'a', systemPrompt: 'p', skillNames: '["java"]' }, 7, 81);
      // 只为被引用的技能物化；已删除且未引用的 ghost 不产生视图
      expect(spy.mock.calls.map((call) => call[1])).toEqual(['java']);
      expect(readdirSync(join(root, 'skill-views', '7')).sort()).toEqual(['java']);
    } finally {
      spy.mockRestore();
    }
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
    // 运行身份参与 state key（技术方案 2026-11-04 §5.3）：查询必须带 userId；
    // 该用户的个人技能仍可用（'mine' 不算 removed），只有被 agent 移除的 'java' 返回。
    expect(svc.getRemovedSkillNames({ ...agent, skillNames: '[]' }, 7, 11)).toEqual(['java']);
    // 无身份时无 state 可查（多发言者下无法判定归属），返回空而不是误报。
    expect(svc.getRemovedSkillNames({ ...agent, skillNames: '[]' }, null, 11)).toEqual([]);
    expect(svc.getRemovedSkillNames(null, 7, 11)).toEqual([]);
    expect(svc.getRemovedSkillNames(agent, 7, null)).toEqual([]);
  });
});
