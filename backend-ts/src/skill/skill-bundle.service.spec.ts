import { mkdtempSync, readdirSync, readFileSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import { SkillLoader } from '../harness/skill/skill-loader.js';
import { SkillBundleService, SKILL_BUNDLE_MAX_BYTES } from './skill-bundle.service.js';
import { SKILL_BUNDLE_FORMAT, type SkillBundle } from './skill-bundle.types.js';
import { UserSkillService } from './user-skill.service.js';

function skillMd(name: string, description = '测试技能'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n正文\n`;
}

describe('SkillBundleService（mao-skill-bundle v1）', () => {
  let root: string;
  let skillsDir: string;
  let userSkillsDir: string;
  let skillLoader: SkillLoader;
  let userSkillService: UserSkillService;
  let service: SkillBundleService;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mao-skillbundle-'));
    skillsDir = join(root, 'skills');
    userSkillsDir = join(root, 'userskills');
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(userSkillsDir, { recursive: true });
    skillLoader = new SkillLoader(new PathSandbox(join(root, 'ws')), skillsDir, 0);
    userSkillService = new UserSkillService(userSkillsDir);
    service = new SkillBundleService(skillLoader, userSkillService);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('导出：用户技能按 owner 读取、round-trip 逐字节一致', async () => {
    mkdirSync(join(userSkillsDir, '8', 'code-review', 'refs'), { recursive: true });
    writeFileSync(join(userSkillsDir, '8', 'code-review', 'SKILL.md'), skillMd('code-review', '代码评审'));
    writeFileSync(join(userSkillsDir, '8', 'code-review', 'refs', 'guide.md'), 'guide content');

    const { bundle, filename } = await service.exportSkillBundle('code-review', 8);
    expect(filename).toBe('mao-skill-bundle-code-review-v1.json');
    expect(bundle.format).toBe(SKILL_BUNDLE_FORMAT);
    expect(bundle.skill).toMatchObject({ name: 'code-review', description: '代码评审' });
    expect(bundle.files['SKILL.md']).toBe(skillMd('code-review', '代码评审'));
    expect(bundle.files['refs/guide.md']).toBe('guide content');

    // 导入到另一个实例（此处以空系统技能目录模拟）
    const report = service.importSkillBundle(JSON.parse(JSON.stringify(bundle)), true);
    expect(report).toMatchObject({ name: 'code-review', action: 'imported' });
    expect(readFileSync(join(skillsDir, 'code-review', 'SKILL.md'), 'utf8')).toBe(bundle.files['SKILL.md']);
    expect(readFileSync(join(skillsDir, 'code-review', 'refs', 'guide.md'), 'utf8')).toBe('guide content');
    expect(skillLoader.hasSkill('code-review')).toBe(true);
  });

  it('导出：系统技能走 getSkillFolder；不存在的技能报 SKILL_NOT_FOUND', async () => {
    mkdirSync(join(skillsDir, 'web-search'), { recursive: true });
    writeFileSync(join(skillsDir, 'web-search', 'SKILL.md'), skillMd('web-search', '搜索'));
    skillLoader.invalidateCache();

    const { bundle } = await service.exportSkillBundle('web-search', null);
    expect(bundle.skill.name).toBe('web-search');

    await expect(service.exportSkillBundle('nope', null)).rejects.toMatchObject({ code: ErrorCode.SKILL_NOT_FOUND.code });
    await expect(service.exportSkillBundle('nope', 8)).rejects.toMatchObject({ code: ErrorCode.SKILL_NOT_FOUND.code });
  });

  it('导入两段式：预检 will-import 不落盘；confirm 才写盘', () => {
    const bundle: SkillBundle = {
      format: SKILL_BUNDLE_FORMAT, formatVersion: 1, exportedAt: '2026-10-05T00:00:00.000Z',
      skill: { name: 'fresh', description: '新技能' },
      files: { 'SKILL.md': skillMd('fresh', '新技能') },
    };
    const precheck = service.importSkillBundle(bundle, false);
    expect(precheck).toMatchObject({ name: 'fresh', action: 'will-import' });
    expect(existsSync(join(skillsDir, 'fresh'))).toBe(false);

    const done = service.importSkillBundle(bundle, true);
    expect(done).toMatchObject({ name: 'fresh', action: 'imported' });
    expect(existsSync(join(skillsDir, 'fresh', 'SKILL.md'))).toBe(true);
  });

  it('exists-skip 不覆盖已有系统技能；隐藏路径段丢弃；路径穿越/超限/校验失败 → invalid', () => {
    mkdirSync(join(skillsDir, 'dup'), { recursive: true });
    writeFileSync(join(skillsDir, 'dup', 'SKILL.md'), skillMd('dup', '旧'));
    skillLoader.invalidateCache();
    const base: SkillBundle = {
      format: SKILL_BUNDLE_FORMAT, formatVersion: 1, exportedAt: '2026-10-05T00:00:00.000Z',
      skill: { name: 'dup', description: '新' }, files: { 'SKILL.md': skillMd('dup', '新') },
    };
    expect(service.importSkillBundle(base, true)).toMatchObject({ action: 'exists-skip' });
    expect(readFileSync(join(skillsDir, 'dup', 'SKILL.md'), 'utf8')).toContain('旧');

    // 隐藏路径段丢弃后正常导入
    skillLoader.invalidateCache();
    const hidden = service.importSkillBundle({
      ...base,
      skill: { name: 'with-hidden', description: 'd' },
      files: { 'SKILL.md': skillMd('with-hidden', 'd'), '.env': 'x', 'refs/.secret': 'x', 'refs/a.md': 'ok' },
    }, true);
    expect(hidden).toMatchObject({ action: 'imported' });
    expect(existsSync(join(skillsDir, 'with-hidden', '.env'))).toBe(false);
    expect(existsSync(join(skillsDir, 'with-hidden', 'refs', 'a.md'))).toBe(true);

    // 路径穿越 → invalid（不落盘）
    const traversal = service.importSkillBundle({
      ...base,
      skill: { name: 'traversal', description: 'd' },
      files: { 'SKILL.md': skillMd('traversal', 'd'), 'a/../../evil.md': 'x' },
    }, false);
    expect(traversal).toMatchObject({ action: 'invalid' });

    // 超总量 → invalid
    const big = service.importSkillBundle({
      ...base,
      skill: { name: 'big', description: 'd' },
      files: { 'SKILL.md': skillMd('big', 'd'), 'big.md': 'x'.repeat(SKILL_BUNDLE_MAX_BYTES + 1) },
    }, false);
    expect(big).toMatchObject({ action: 'invalid' });

    // frontmatter 与技能名不一致 → invalid
    const mismatch = service.importSkillBundle({
      ...base,
      skill: { name: 'named', description: 'd' },
      files: { 'SKILL.md': skillMd('other', 'd') },
    }, false);
    expect(mismatch.action).toBe('invalid');

    // 缺 SKILL.md → invalid
    const noMd = service.importSkillBundle({
      ...base,
      skill: { name: 'nomd', description: 'd' },
      files: { 'readme.md': 'x' },
    }, false);
    expect(noMd.action).toBe('invalid');
  });

  it('格式不识别抛 PARAM_INVALID；非法技能名抛 PARAM_INVALID', () => {
    expect(() => service.importSkillBundle({ format: 'other', formatVersion: 1 }, false))
      .toThrowError(expect.objectContaining({ code: ErrorCode.PARAM_INVALID.code }));
    expect(() => service.importSkillBundle({ format: SKILL_BUNDLE_FORMAT, formatVersion: 2 }, false))
      .toThrowError(expect.objectContaining({ code: ErrorCode.PARAM_INVALID.code }));
    expect(() => service.importSkillBundle({ format: SKILL_BUNDLE_FORMAT, formatVersion: 1, skill: { name: '../evil' }, files: {} }, false))
      .toThrowError(expect.objectContaining({ code: ErrorCode.PARAM_INVALID.code }));
  });

  it('导出含二进制文件时跳过并在 warnings 标注', async () => {    await userSkillService.uploadUserSkill(8, [
      { originalFilename: 'with-bin/SKILL.md', buffer: Buffer.from(skillMd('with-bin', 'd')) },
      { originalFilename: 'with-bin/assets/logo.bin', buffer: Buffer.from([0, 159, 146, 150]) },
    ]);
    const { bundle } = await service.exportSkillBundle('with-bin', 8);
    expect(bundle.files['SKILL.md']).toBeDefined();
    expect(bundle.files['assets/logo.bin']).toBeUndefined();
    expect(bundle.warnings).toEqual(['binary file skipped: assets/logo.bin']);
  });
});
