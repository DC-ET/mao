import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTmpDir } from '../testing/tmp-dir.js';
import { UserSkillService } from './user-skill.service.js';

function skill(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

describe('UserSkillService', () => {
  it('listsReadsUploadsAndDeletesUserSkills', async () => {
    const dir = useTmpDir('mao-uskill-');
    const service = new UserSkillService(dir);
    const existing = join(dir, '7', 'existing');
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, 'SKILL.md'), skill('existing', 'Existing', 'Body'));

    const list = service.listUserSkills(7);
    expect(list.map((s) => s.name)).toEqual(['existing']);

    const existingDir = join(dir, '8', 'other-user-skill');
    mkdirSync(existingDir, { recursive: true });
    writeFileSync(join(existingDir, 'SKILL.md'), skill('other-user-skill', 'Other', 'Other body'));
    const all = service.listAllUserSkills();
    expect(all.map((s) => `${s.userId}:${s.name}`)).toEqual(['7:existing', '8:other-user-skill']);

    const detail = service.getUserSkill(7, 'existing');
    expect(detail.code).toBe(0);
    expect(detail.data?.body).toBe('Body');

    const uploaded = service.uploadUserSkill(7, [
      { originalFilename: 'new/SKILL.md', buffer: Buffer.from(skill('new', 'New', 'New body')) },
      { originalFilename: 'new/ref/info.txt', buffer: Buffer.from('info') },
      { originalFilename: 'new/.secret', buffer: Buffer.from('skip') },
      { originalFilename: 'new/ref/.secret', buffer: Buffer.from('skip') },
    ]);
    expect(uploaded.code).toBe(0);
    expect(uploaded.data).toEqual(['new']);
    expect(join(dir, '7', 'new', 'SKILL.md')).toBeTruthy();
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(dir, '7', 'new', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, '7', 'new', 'ref', 'info.txt'))).toBe(true);
    expect(existsSync(join(dir, '7', 'new', '.secret'))).toBe(true);
    expect(existsSync(join(dir, '7', 'new', 'ref', '.secret'))).toBe(false);

    const deleted = service.deleteUserSkill(7, 'new');
    expect(deleted.code).toBe(0);
    expect(existsSync(join(dir, '7', 'new'))).toBe(false);
  });

  it('restoresExecutableBitsForUploadedScripts', async () => {
    const dir = useTmpDir('mao-uskill-');
    const service = new UserSkillService(dir);
    const uploaded = service.uploadUserSkill(7, [
      { originalFilename: 'cli/SKILL.md', buffer: Buffer.from(skill('cli', 'CLI', 'Body')) },
      { originalFilename: 'cli/run.sh', buffer: Buffer.from('#!/bin/sh\necho hi') },
      { originalFilename: 'cli/tools/exec-py', buffer: Buffer.from('#!/usr/bin/env python3\nprint(1)') },
      { originalFilename: 'cli/tools/plain.txt', buffer: Buffer.from('text') },
    ]);
    expect(uploaded.code).toBe(0);
    const { statSync } = await import('node:fs');
    const base = join(dir, '7', 'cli');
    // 执行位断言不受进程 umask 影响
    expect(statSync(join(base, 'run.sh')).mode & 0o111).toBe(0o111);
    expect(statSync(join(base, 'tools', 'exec-py')).mode & 0o111).toBe(0o111);
    expect(statSync(join(base, 'SKILL.md')).mode & 0o111).toBe(0);
    expect(statSync(join(base, 'tools', 'plain.txt')).mode & 0o111).toBe(0);
  });

  it('returnsFailuresForInvalidUploadReadAndDeleteRequests', async () => {
    const dir = useTmpDir('mao-uskill-');
    const service = new UserSkillService(dir);
    expect(service.listUserSkills(7)).toEqual([]);
    expect(service.listAllUserSkills()).toEqual([]);
    expect(service.getUserSkill(7, 'missing').code).toBe(404);
    expect(service.deleteUserSkill(7, 'missing').code).toBe(404);
    expect(service.getUserSkill(7, '../outside').code).toBe(400);
    expect(service.deleteUserSkill(7, '../../..').code).toBe(400);
    expect(service.uploadUserSkill(7, null).code).toBe(400);
    expect(service.uploadUserSkill(7, []).code).toBe(400);
    expect(service.uploadUserSkill(7, [{ originalFilename: 'SKILL.md', buffer: Buffer.from('x') }]).code).toBe(400);
    expect(service.uploadUserSkill(7, [{ originalFilename: 'bad/readme.md', buffer: Buffer.from('x') }]).message).toContain('missing SKILL.md');
    expect(service.uploadUserSkill(7, [{ originalFilename: 'bad/SKILL.md', buffer: Buffer.from('no yaml') }]).message).toContain('frontmatter');
    expect(service.uploadUserSkill(7, [{
      originalFilename: 'bad/SKILL.md',
      buffer: Buffer.from('---\nname: bad\n---\nbody\n'),
    }]).message).toContain('description');
  });

  it('replacesSkillOnlyAfterStagingSucceeds', () => {
    const dir = useTmpDir('mao-uskill-');
    const service = new UserSkillService(dir);
    const folder = join(dir, '7', 'keep');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'SKILL.md'), skill('keep', 'Keep', 'Old'));

    const invalid = service.uploadUserSkill(7, [
      { originalFilename: 'keep/SKILL.md', buffer: Buffer.from(skill('keep', 'Keep', 'New')) },
      { originalFilename: 'bad/readme.md', buffer: Buffer.from('x') },
    ]);
    expect(invalid.code).toBe(400);
    expect(readFileSync(join(folder, 'SKILL.md'), 'utf8')).toContain('Old');

    const replaced = service.uploadUserSkill(7, [
      { originalFilename: 'keep/SKILL.md', buffer: Buffer.from(skill('keep', 'Keep', 'New')) },
      { originalFilename: 'other/SKILL.md', buffer: Buffer.from(skill('other', 'Other', 'Body')) },
    ]);
    expect(replaced.code).toBe(0);
    expect(replaced.data).toEqual(['keep', 'other']);
    expect(readFileSync(join(folder, 'SKILL.md'), 'utf8')).toContain('New');
    expect(readFileSync(join(dir, '7', 'other', 'SKILL.md'), 'utf8')).toContain('Body');
    expect(service.listUserSkills(7).map((item) => item.name).sort()).toEqual(['keep', 'other']);
  });

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'keepsExistingSkillWhenReplaceCannotStart',
    () => {
      const dir = useTmpDir('mao-uskill-');
      const service = new UserSkillService(dir);
      const userDir = join(dir, '7');
      const folder = join(userDir, 'keep');
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'SKILL.md'), skill('keep', 'Keep', 'Old'));
      chmodSync(userDir, 0o555);
      try {
        const failed = service.uploadUserSkill(7, [
          { originalFilename: 'keep/SKILL.md', buffer: Buffer.from(skill('keep', 'Keep', 'New')) },
        ]);
        expect(failed.code).toBe(500);
        expect(failed.message).toContain('原技能未替换');
        expect(readFileSync(join(folder, 'SKILL.md'), 'utf8')).toContain('Old');
      } finally {
        chmodSync(userDir, 0o755);
      }
    },
  );
});

describe('UserSkillService.installUserSkillFiles（依赖一键补装）', () => {
  it('内存文件安装：写盘成功且隐藏路径段被过滤', async () => {
    const dir = useTmpDir('mao-uskill-install-');
    const service = new UserSkillService(dir);
    const { existsSync } = await import('node:fs');

    const installed = service.installUserSkillFiles(7, 'code-review', {
      'SKILL.md': skill('code-review', 'Review', 'Body'),
      'refs/guide.md': 'guide content',
      '.hidden': 'skip',
      'refs/.secret': 'skip',
    });
    expect(installed).toMatchObject({ code: 0, data: 'code-review' });
    expect(existsSync(join(dir, '7', 'code-review', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(dir, '7', 'code-review', 'refs', 'guide.md'))).toBe(true);
    expect(existsSync(join(dir, '7', 'code-review', '.hidden'))).toBe(false);
    expect(existsSync(join(dir, '7', 'code-review', 'refs', '.secret'))).toBe(false);
    expect(service.listUserSkills(7).map((s) => s.name)).toEqual(['code-review']);
  });

  it('校验链：SKILL.md 缺失/结构非法/frontmatter 不一致/名称非法/路径穿越/超总量均拒绝且不落盘', async () => {
    const dir = useTmpDir('mao-uskill-install-bad-');
    const service = new UserSkillService(dir);
    const { existsSync } = await import('node:fs');

    expect(service.installUserSkillFiles(7, 'x', { 'refs/a.md': 'no SKILL.md' }).code).toBe(400);
    expect(service.installUserSkillFiles(7, 'x', { 'SKILL.md': 'no frontmatter' }).code).toBe(400);
    expect(service.installUserSkillFiles(7, 'x', { 'SKILL.md': skill('other', 'D', 'B') }).message).toContain('不一致');
    expect(service.installUserSkillFiles(7, '../escape', { 'SKILL.md': skill('../escape', 'D', 'B') }).code).toBe(400);
    expect(service.installUserSkillFiles(7, 'x', { 'SKILL.md': skill('x', 'D', 'B'), 'a/../../evil.md': 'x' }).code).toBe(400);
    expect(service.installUserSkillFiles(7, 'x', { 'SKILL.md': skill('x', 'D', 'B'), '': 'empty path' }).code).toBe(400);

    const big = 'a'.repeat(6 * 1024 * 1024);
    expect(service.installUserSkillFiles(7, 'x', { 'SKILL.md': skill('x', 'D', 'B'), 'big1.md': big, 'big2.md': big }).message).toContain('上限');
    expect(existsSync(join(dir, '7', 'x'))).toBe(false);
  });

  it('目标同名目录已存在即拒绝覆盖：不替换、不触发暂存交换', async () => {
    const dir = useTmpDir('mao-uskill-install-reject-');
    const service = new UserSkillService(dir);
    const { existsSync } = await import('node:fs');

    // 自检按 frontmatter 名判缺失、写盘按目录名落盘："目录 A、frontmatter 名 B"的技能
    // 会让补装静默覆盖 A/（rename 备份成功后即删除）。此处断言写盘侧显式拒绝
    mkdirSync(join(dir, '7', 'dup'), { recursive: true });
    writeFileSync(join(dir, '7', 'dup', 'SKILL.md'), skill('dup', 'Old', 'Old'));
    const rejected = service.installUserSkillFiles(7, 'dup', { 'SKILL.md': skill('dup', 'New', 'New') });
    expect(rejected.code).toBe(409);
    expect(rejected.message).toContain('拒绝覆盖');
    expect(readFileSync(join(dir, '7', 'dup', 'SKILL.md'), 'utf8')).toContain('Old');
    expect(existsSync(join(dir, '.staging'))).toBe(false);
  });
});
