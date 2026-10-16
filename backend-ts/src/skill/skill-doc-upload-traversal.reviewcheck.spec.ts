import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import { SkillLoader } from '../harness/skill/skill-loader.js';
import { SkillDocService } from './skill-doc.service.js';

/**
 * 回归测试：对 BUG-3 修复（skill-doc.service.ts 段校验 + 解析后路径收口）
 * 做扩大向量验证。所有穿越形态都不得把文件写到技能子目录之外；合法嵌套文件必须仍能落盘。
 * 断言按「正确行为」书写，失败即证明修复不完整。
 */
describe('skill upload traversal (extended vectors)', () => {
  let cleanup: (() => void) | null = null;

  function createService(): { service: SkillDocService; skillsDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'mao-skill-upload-rc-'));
    cleanup = () => rmSync(root, { recursive: true, force: true });
    const skillsDir = join(root, 'skills');
    return { service: new SkillDocService(new SkillLoader(new PathSandbox(root), skillsDir)), skillsDir };
  }

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('rejects every traversal shape and keeps legit nested files working', async () => {
    const { service, skillsDir } = createService();
    const result = service.uploadSkill([
      // --- 穿越向量（全部不得越出 myskill/） ---
      { originalFilename: 'myskill/../evil.txt', buffer: Buffer.from('pwned') },
      { originalFilename: 'myskill/../../evil2.txt', buffer: Buffer.from('pwned') },
      { originalFilename: 'myskill/sub/../../evil3.txt', buffer: Buffer.from('pwned') },
      { originalFilename: 'myskill/./../evil4.txt', buffer: Buffer.from('pwned') },
      { originalFilename: 'myskill\\..\\evil5.txt', buffer: Buffer.from('pwned') },
      { originalFilename: 'myskill//../evil6.txt', buffer: Buffer.from('pwned') },
      { originalFilename: 'myskill/..', buffer: Buffer.from('pwned') },
      { originalFilename: 'myskill/../', buffer: Buffer.from('pwned') },
      { originalFilename: '../myskill/SKILL.md', buffer: Buffer.from('pwned') },
      { originalFilename: './myskill/SKILL.md', buffer: Buffer.from('pwned') },
      { originalFilename: '/myskill/SKILL.md', buffer: Buffer.from('pwned') },
      { originalFilename: '..%2fmyskill/SKILL.md', buffer: Buffer.from('pwned') },
      // --- 合法文件（必须落盘） ---
      { originalFilename: 'myskill/SKILL.md', buffer: Buffer.from('# ok\n') },
      { originalFilename: 'myskill/sub/nested.md', buffer: Buffer.from('# nested\n') },
    ]);

    // skills 根下只允许出现 myskill 一个目录，不得有任何 evil*/SKILL.md 越界产物
    const rootEntries = existsSync(skillsDir) ? readdirSync(skillsDir) : [];
    expect(rootEntries.filter((n) => n !== 'myskill')).toEqual([]);
    for (const evil of ['evil.txt', 'evil2.txt', 'evil3.txt', 'evil4.txt', 'evil5.txt', 'evil6.txt', 'SKILL.md']) {
      expect(existsSync(join(skillsDir, evil))).toBe(false);
    }
    // 对照组：合法文件（含嵌套子目录）正常落盘
    expect(existsSync(join(skillsDir, 'myskill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsDir, 'myskill', 'sub', 'nested.md'))).toBe(true);
    // 上传整体仍报成功（跳过非法项而非整体 500）
    expect(result.code).toBe(0);
  });

  it('percent-encoded and dot-prefixed names stay inside the skill folder', async () => {
    const { service, skillsDir } = createService();
    // %2e%2e 不被服务端解码，只是普通目录名；./ 前导段归一化后仍在技能子目录内
    service.uploadSkill([
      { originalFilename: 'myskill/%2e%2e/evil.txt', buffer: Buffer.from('x') },
      { originalFilename: 'myskill/./ok.txt', buffer: Buffer.from('x') },
    ]);
    const rootEntries = existsSync(skillsDir) ? readdirSync(skillsDir) : [];
    expect(rootEntries.filter((n) => n !== 'myskill')).toEqual([]);
    expect(existsSync(join(skillsDir, 'myskill', '%2e%2e', 'evil.txt'))).toBe(true);
    expect(existsSync(join(skillsDir, 'myskill', 'ok.txt'))).toBe(true);
  });
});
