import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { useTmpDir } from '../../testing/tmp-dir.js';
import { SkillLoader } from './skill-loader.js';
import { PathSandbox } from '../safety/path-sandbox.js';
import type { SkillDocument } from './skill-md.js';

function skillMd(name: string, description = 'Demo skill'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`;
}

function builtinDoc(name: string, folder: string): SkillDocument {
  return {
    name,
    description: `${name} builtin`,
    body: 'Body',
    filePath: join(folder, name, 'SKILL.md'),
    folderPath: join(folder, name),
    builtin: true,
  };
}

describe('SkillLoader', () => {
  it('loadsSkillMdDocumentsAndInvalidatesCache', async () => {
    const dir = useTmpDir('mao-skills-');
    mkdirSync(join(dir, 'demo'), { recursive: true });
    writeFileSync(join(dir, 'demo', 'SKILL.md'), skillMd('demo'));
    const loader = new SkillLoader(new PathSandbox(dir), dir, 300);
    expect(loader.getAllNames()).toEqual(['demo']);
    expect(loader.hasSkill('demo')).toBe(true);
    expect(loader.getSkillFolder('demo')).toContain('demo');
    expect(loader.getCatalogWithPaths(['demo'])).toContain('demo');
    loader.invalidateCache();
    expect(loader.getAllDocuments()[0].body).toBe('Body');
  });

  it('不传内置技能时行为与从前一致：只扫可变根，无内置标记', () => {
    const dir = useTmpDir('mao-skills-');
    mkdirSync(join(dir, 'demo'), { recursive: true });
    writeFileSync(join(dir, 'demo', 'SKILL.md'), skillMd('demo'));
    const loader = new SkillLoader(new PathSandbox(dir), dir, 300);
    expect(loader.getAllNames()).toEqual(['demo']);
    expect(loader.isBuiltin('demo')).toBe(false);
    expect(loader.isBuiltin('missing')).toBe(false);
  });

  it('合并内置与可变根：身份取 frontmatter 名，仅内置为 isBuiltin', () => {
    const mutableDir = useTmpDir('mao-skills-mutable-');
    const builtinDir = useTmpDir('mao-skills-builtin-');
    mkdirSync(join(mutableDir, 'uploaded'), { recursive: true });
    writeFileSync(join(mutableDir, 'uploaded', 'SKILL.md'), skillMd('uploaded'));
    const loader = new SkillLoader(
      new PathSandbox(mutableDir),
      mutableDir,
      300,
      [builtinDoc('mao-cli', builtinDir)],
    );
    expect(loader.getAllNames().sort()).toEqual(['mao-cli', 'uploaded']);
    expect(loader.isBuiltin('mao-cli')).toBe(true);
    expect(loader.isBuiltin('uploaded')).toBe(false);
    // 内置 folderPath 指向仓库侧源目录
    expect(loader.getSkillFolder('mao-cli')).toBe(join(builtinDir, 'mao-cli'));
    expect(loader.getAllDocuments().find((d) => d.name === 'mao-cli')?.builtin).toBe(true);
  });

  it('可变根同名残留被丢弃：只有内置那份，getSkillFolder 指向仓库侧', () => {
    const mutableDir = useTmpDir('mao-skills-stale-');
    const builtinDir = useTmpDir('mao-skills-builtin-');
    mkdirSync(join(mutableDir, 'stale-mao-cli'), { recursive: true });
    writeFileSync(join(mutableDir, 'stale-mao-cli', 'SKILL.md'), skillMd('mao-cli', 'stale copy'));
    const loader = new SkillLoader(
      new PathSandbox(mutableDir),
      mutableDir,
      300,
      [builtinDoc('mao-cli', builtinDir)],
    );
    expect(loader.getAllNames()).toEqual(['mao-cli']);
    expect(loader.getSkillFolder('mao-cli')).toBe(join(builtinDir, 'mao-cli'));
    expect(loader.getAllDocuments().find((d) => d.name === 'mao-cli')?.description).toBe('mao-cli builtin');
  });

  it('同一轮刷新里同一内置名的冲突警告只打一次', () => {
    const mutableDir = useTmpDir('mao-skills-warn-');
    const builtinDir = useTmpDir('mao-skills-builtin-');
    mkdirSync(join(mutableDir, 'stale-a'), { recursive: true });
    writeFileSync(join(mutableDir, 'stale-a', 'SKILL.md'), skillMd('mao-cli'));
    mkdirSync(join(mutableDir, 'stale-b'), { recursive: true });
    writeFileSync(join(mutableDir, 'stale-b', 'SKILL.md'), skillMd('mao-cli'));
    const loader = new SkillLoader(
      new PathSandbox(mutableDir),
      mutableDir,
      300,
      [builtinDoc('mao-cli', builtinDir)],
    );
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      loader.invalidateCache();
      loader.getAllNames();
      const conflictWarnings = stderrSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('conflicts with builtin'));
      expect(conflictWarnings).toHaveLength(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
