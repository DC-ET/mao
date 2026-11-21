import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { useTmpDir } from '../testing/tmp-dir.js';
import { SkillDocService } from './skill-doc.service.js';
import { SkillLoader } from '../harness/skill/skill-loader.js';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import type { SkillDocument } from '../harness/skill/skill-md.js';
import type { UploadedSkillFile } from './user-skill.service.js';

function skillMd(name: string, description = 'Demo skill'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\nBody\n`;
}

/** multipart 上传体里的文件按 `originalFilename` 的顶层目录段分组，这里直接构造同形文件列表。 */
function file(path: string, content: string): UploadedSkillFile {
  return { originalFilename: path, buffer: Buffer.from(content, 'utf8') };
}

function builtinDoc(name: string, builtinRoot: string): SkillDocument {
  return {
    name,
    description: `${name} builtin`,
    body: 'Body',
    filePath: join(builtinRoot, name, 'SKILL.md'),
    folderPath: join(builtinRoot, name),
    builtin: true,
  };
}

function loaderWithBuiltins(mutableDir: string, builtinRoot: string, names: string[]): SkillLoader {
  return new SkillLoader(
    new PathSandbox(mutableDir),
    mutableDir,
    0,
    names.map((name) => builtinDoc(name, builtinRoot)),
  );
}

describe('SkillDocService（系统技能写路径）', () => {
  it('列表带 builtin 标记：内置为 true，上传技能为 false', () => {
    const mutableDir = useTmpDir('mao-sdoc-mutable-');
    const builtinRoot = useTmpDir('mao-sdoc-builtin-');
    mkdirSync(join(mutableDir, 'uploaded'), { recursive: true });
    writeFileSync(join(mutableDir, 'uploaded', 'SKILL.md'), skillMd('uploaded'));
    const loader = loaderWithBuiltins(mutableDir, builtinRoot, ['mao-cli']);
    const docs = new SkillDocService(loader).listSkillDocs();
    expect(docs.map((d) => d.name).sort()).toEqual(['mao-cli', 'uploaded']);
    expect(docs.find((d) => d.name === 'mao-cli')?.builtin).toBe(true);
    expect(docs.find((d) => d.name === 'uploaded')?.builtin).toBe(false);
  });

  it('上传 frontmatter 命中内置名：整请求 409，一个文件都不落盘', () => {
    const mutableDir = useTmpDir('mao-sdoc-mutable-');
    const builtinRoot = useTmpDir('mao-sdoc-builtin-');
    const loader = loaderWithBuiltins(mutableDir, builtinRoot, ['mao-cli']);
    const service = new SkillDocService(loader);
    const result = service.uploadSkill([
      file('mao-cli/SKILL.md', skillMd('mao-cli')),
      file('other-team/SKILL.md', skillMd('other-team')),
      file('other-team/refs/guide.md', 'guide'),
    ]);
    expect(result.code).toBe(409);
    expect(result.message).toContain('禁止上传');
    expect(result.message).toContain('mao-cli');
    // 未命中内置名的组也不写（整请求原子拒绝）
    expect(existsSync(join(mutableDir, 'mao-cli'))).toBe(false);
    expect(existsSync(join(mutableDir, 'other-team'))).toBe(false);
    expect(readdirSync(mutableDir)).toEqual([]);
  });

  it('组名（目录名）与内置名相同但 frontmatter 名不同：不 409，照常写入', () => {
    const mutableDir = useTmpDir('mao-sdoc-mutable-');
    const builtinRoot = useTmpDir('mao-sdoc-builtin-');
    const loader = loaderWithBuiltins(mutableDir, builtinRoot, ['mao-cli']);
    const result = new SkillDocService(loader).uploadSkill([
      file('mao-cli/SKILL.md', skillMd('my-own-cli')),
    ]);
    expect(result.code).toBe(0);
    expect(existsSync(join(mutableDir, 'mao-cli', 'SKILL.md'))).toBe(true);
  });

  it('组内没有 SKILL.md：保持今天行为照常写入（不触发内置判名）', () => {
    const mutableDir = useTmpDir('mao-sdoc-mutable-');
    const builtinRoot = useTmpDir('mao-sdoc-builtin-');
    const loader = loaderWithBuiltins(mutableDir, builtinRoot, ['mao-cli']);
    const result = new SkillDocService(loader).uploadSkill([
      file('plain-notes/readme.txt', 'hello'),
    ]);
    expect(result.code).toBe(0);
    expect(existsSync(join(mutableDir, 'plain-notes', 'readme.txt'))).toBe(true);
  });

  it('删除上传的技能：只删除可变根内的目录', () => {
    const mutableDir = useTmpDir('mao-sdoc-mutable-');
    mkdirSync(join(mutableDir, 'uploaded'), { recursive: true });
    writeFileSync(join(mutableDir, 'uploaded', 'SKILL.md'), skillMd('uploaded'));
    const loader = new SkillLoader(new PathSandbox(mutableDir), mutableDir, 0);
    const result = new SkillDocService(loader).deleteSkill('uploaded');
    expect(result.code).toBe(0);
    expect(existsSync(join(mutableDir, 'uploaded'))).toBe(false);
  });

  it('删除目标落在可变根之外：500 且不删除（第二道防线，防 rm 到 git 检出）', () => {
    const mutableDir = useTmpDir('mao-sdoc-mutable-');
    const outsideDir = useTmpDir('mao-sdoc-outside-');
    mkdirSync(join(outsideDir, 'escaped'), { recursive: true });
    writeFileSync(join(outsideDir, 'escaped', 'SKILL.md'), skillMd('escaped'));
    // 名册判断漏判（isBuiltin=false）但 folder 在可变根外：第二道防线必须拦下
    const fakeLoader = {
      getSkillsDir: () => mutableDir,
      isBuiltin: () => false,
      getSkillFolder: () => join(outsideDir, 'escaped'),
      getAllDocuments: () => [],
      getAllNames: () => ['escaped'],
      hasSkill: () => true,
      invalidateCache: () => undefined,
    } as unknown as SkillLoader;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = new SkillDocService(fakeLoader).deleteSkill('escaped');
      expect(result.code).toBe(500);
      expect(existsSync(join(outsideDir, 'escaped'))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
