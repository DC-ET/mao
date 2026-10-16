import { existsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import { SkillLoader } from '../harness/skill/skill-loader.js';
import { SkillDocService } from './skill-doc.service.js';

/**
 * BUGCHECK（审查新增，非产品代码）：skill-doc.service.ts:64-66 的上传落盘守卫
 * 只查 `relativePath.includes('/.')`，而 `relativeAfterSkill('myskill/../evil.txt')`
 * 得到 `'../evil.txt'`——`..` 在最前、前面没有 `/`，includes('/.') 为 false，
 * 守卫被绕过，join(skillsDir, 'myskill', '../evil.txt') 归一化后写到
 * <skillsDir>/evil.txt，越出技能子目录（可覆盖/注入其它技能或 skills 根）。
 * 姊妹实现 user-skill.service.ts writeSkillGroup 与 staged-skill-writer.ts 均按段
 * 拒绝 `..`，此处属实现遗漏。
 * 断言按「正确行为」书写，当前源码下失败即证明 BUG 真实存在。
 */
describe('BUGCHECK skill upload path traversal', () => {
  let cleanup: (() => void) | null = null;

  function createService(): { service: SkillDocService; skillsDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'mao-skill-upload-'));
    cleanup = () => rmSync(root, { recursive: true, force: true });
    const skillsDir = join(root, 'skills');
    return { service: new SkillDocService(new SkillLoader(new PathSandbox(root), skillsDir)), skillsDir };
  }

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('never writes outside the skill subdirectory', async () => {
    const { service, skillsDir } = createService();
    service.uploadSkill([
      { originalFilename: 'myskill/../evil.txt', buffer: Buffer.from('pwned') },
      { originalFilename: 'myskill/SKILL.md', buffer: Buffer.from('# ok\n') },
    ]);
    // 正确行为：穿越文件被拒绝或收敛进 myskill/，任何情况下 skills 根都不得出现 evil.txt
    expect(existsSync(join(skillsDir, 'evil.txt'))).toBe(false);
    // 对照组：合法文件正常落盘（证明失败不是上传机制本身不工作）
    expect(existsSync(join(skillsDir, 'myskill', 'SKILL.md'))).toBe(true);
  });
});
