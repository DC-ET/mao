import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTmpDir, useTmpDirOutsideRepo } from '../../testing/tmp-dir.js';
import { assertMutableRootSeparate, BuiltinSkillCatalog, locateBuiltinRoot } from './builtin-skill-catalog.js';

function skillMd(name: string, description = '内置测试技能'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n正文\n`;
}

/** 写内置根名单（自动建 skills/ 目录）。 */
function writeBuiltinList(root: string, names: string[]): void {
  mkdirSync(join(root, 'skills'), { recursive: true });
  writeFileSync(join(root, 'skills', 'builtin.json'), JSON.stringify({ skills: names }));
}

/** 建一份最小内置根：<root>/skills/{builtin.json, <dir>/SKILL.md}。 */
function seedWhitelistSkill(root: string, dirName: string, frontName = dirName): void {
  mkdirSync(join(root, 'skills', dirName), { recursive: true });
  writeFileSync(join(root, 'skills', dirName, 'SKILL.md'), skillMd(frontName));
  writeBuiltinList(root, [dirName]);
}

describe('BuiltinSkillCatalog（内置技能目录）', () => {
  let root: string;
  let catalog: BuiltinSkillCatalog;

  beforeEach(() => {
    root = useTmpDir('mao-builtin-root-');
    catalog = new BuiltinSkillCatalog();
  });

  it('合法名单 + bundled 技能 + 可变根并列：全部载入且仅内置带 builtin 标记', () => {
    seedWhitelistSkill(root, 'mao-cli');
    mkdirSync(join(root, 'skills', 'bundled', 'my-bundle'), { recursive: true });
    writeFileSync(join(root, 'skills', 'bundled', 'my-bundle', 'SKILL.md'), skillMd('my-bundle'));
    writeFileSync(join(root, 'skills', 'bundled', 'README.md'), '说明文件，不是技能');

    const skills = catalog.load(join(root, 'skills'));
    expect(skills.map((s) => s.name).sort()).toEqual(['mao-cli', 'my-bundle']);
    for (const skill of skills) {
      expect(skill.builtin).toBe(true);
      expect(skill.folderPath).toContain(join(root, 'skills'));
    }
  });

  it('bundled 里没有 SKILL.md 的子目录：跳过并保留其余技能，load 成功', () => {
    seedWhitelistSkill(root, 'mao-cli');
    mkdirSync(join(root, 'skills', 'bundled', 'no-skill-md'), { recursive: true });
    mkdirSync(join(root, 'skills', 'bundled', 'good'), { recursive: true });
    writeFileSync(join(root, 'skills', 'bundled', 'good', 'SKILL.md'), skillMd('good'));

    const skills = catalog.load(join(root, 'skills'));
    expect(skills.map((s) => s.name).sort()).toEqual(['good', 'mao-cli']);
  });

  it('bundled 目录整个缺失：视为空集，load 成功', () => {
    seedWhitelistSkill(root, 'mao-cli');
    const skills = catalog.load(join(root, 'skills'));
    expect(skills.map((s) => s.name)).toEqual(['mao-cli']);
  });

  it.each([
    ['上级穿越', ['../evil']],
    ['绝对路径', ['/etc/mao-cli']],
    ['带斜杠', ['a/b']],
    ['空串', ['']],
    ['保留名 bundled', ['bundled']],
    ['非法字符', ['中文名']],
  ])('名单项非法（%s）→ load 抛错', (_label, items) => {
    writeBuiltinList(root, items);
    expect(() => catalog.load(join(root, 'skills'))).toThrow(/builtin\.json|非法/);
  });

  it('名单 JSON 损坏 / 缺 skills 数组 → load 抛错', () => {
    mkdirSync(join(root, 'skills'), { recursive: true });
    writeFileSync(join(root, 'skills', 'builtin.json'), '{ not json');
    expect(() => catalog.load(join(root, 'skills'))).toThrow(/JSON 损坏/);
    writeFileSync(join(root, 'skills', 'builtin.json'), JSON.stringify({ foo: [] }));
    expect(() => catalog.load(join(root, 'skills'))).toThrow(/skills/);
  });

  it('白名单点名的目录缺 SKILL.md → load 抛错（信息带路径）', () => {
    mkdirSync(join(root, 'skills', 'mao-cli'), { recursive: true });
    writeBuiltinList(root, ['mao-cli']);
    expect(() => catalog.load(join(root, 'skills'))).toThrow(/mao-cli/);
  });

  it('bundled 目录 SKILL.md frontmatter 非法 → load 抛错（发版错误）', () => {
    writeBuiltinList(root, []);
    mkdirSync(join(root, 'skills', 'bundled', 'broken'), { recursive: true });
    writeFileSync(join(root, 'skills', 'bundled', 'broken', 'SKILL.md'), '没有 frontmatter 的正文');
    expect(() => catalog.load(join(root, 'skills'))).toThrow(/broken/);
  });

  it('两个内置技能 frontmatter 同名（白名单 vs bundled）→ load 抛错', () => {
    seedWhitelistSkill(root, 'mao-cli', 'same-name');
    mkdirSync(join(root, 'skills', 'bundled', 'dup'), { recursive: true });
    writeFileSync(join(root, 'skills', 'bundled', 'dup', 'SKILL.md'), skillMd('same-name'));
    expect(() => catalog.load(join(root, 'skills'))).toThrow(/same-name/);
  });
});

describe('locateBuiltinRoot（内置根向上定位）', () => {
  // 定位依赖向上遍历：夹具必须在 git 仓库外（useTmpDirOutsideRepo 的设计用途），
  // 否则仓库内夹具向上会先命中真实仓库根的 skills/builtin.json
  function outsideRoot(): string {
    return useTmpDirOutsideRepo('mao-builtin-walk-');
  }

  it('dist 布局（backend-ts/dist/harness/skill/）向上找到仓库根', () => {
    const root = outsideRoot();
    seedWhitelistSkill(root, 'mao-cli');
    const fakeModuleDir = join(root, 'backend-ts', 'dist', 'harness', 'skill');
    mkdirSync(fakeModuleDir, { recursive: true });
    const found = locateBuiltinRoot(pathToFileURL(join(fakeModuleDir, 'builtin-skill-catalog.js')).href);
    expect(found).toBe(join(root, 'skills'));
  });

  it('src 布局（backend-ts/src/harness/skill/）向上找到仓库根', () => {
    const root = outsideRoot();
    seedWhitelistSkill(root, 'mao-cli');
    const fakeModuleDir = join(root, 'backend-ts', 'src', 'harness', 'skill');
    mkdirSync(fakeModuleDir, { recursive: true });
    const found = locateBuiltinRoot(pathToFileURL(join(fakeModuleDir, 'builtin-skill-catalog.ts')).href);
    expect(found).toBe(join(root, 'skills'));
  });

  it('找不到 skills/builtin.json → 抛错（D7，不静默降级为空集）', () => {
    const root = outsideRoot();
    const deep = join(root, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    expect(() => locateBuiltinRoot(pathToFileURL(join(deep, 'x.js')).href)).toThrow(/未找到内置技能根/);
  });
});

describe('assertMutableRootSeparate（D10 两根重叠防护）', () => {
  it('可变根与内置根相同 → 抛错', () => {
    expect(() => assertMutableRootSeparate('/opt/mao/skills', '/opt/mao/skills')).toThrow(/SKILLS_DIR/);
  });

  it('可变根位于内置根内 → 抛错', () => {
    expect(() => assertMutableRootSeparate('/opt/mao/skills/uploads', '/opt/mao/skills')).toThrow(/SKILLS_DIR/);
  });

  it('两根分离 → 通过', () => {
    expect(() => assertMutableRootSeparate('/opt/mao-data/skills', '/opt/mao/skills')).not.toThrow();
    expect(() => assertMutableRootSeparate('/opt/mao-data', '/opt/mao/skills')).not.toThrow();
  });

  it('内置根位于可变根内 → 抛错（反向重叠，如 SKILLS_DIR=/opt/mao）', () => {
    expect(() => assertMutableRootSeparate('/opt/mao', '/opt/mao/skills')).toThrow(/SKILLS_DIR/);
  });

  it('路径写法差异（尾部斜杠 / 相对段）按 resolve 归一后比较', () => {
    expect(() => assertMutableRootSeparate('/opt/mao/skills//', '/opt/mao/skills')).toThrow(/SKILLS_DIR/);
    expect(() => assertMutableRootSeparate('/opt/mao/./skills', '/opt/mao/skills')).toThrow(/SKILLS_DIR/);
    expect(() => assertMutableRootSeparate('/opt/mao-data/skills/', '/opt/mao/skills')).not.toThrow();
  });
});
