import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { UserSkillService } from './user-skill.service.js';

function skill(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`;
}

describe('UserSkillService', () => {
  it('listsReadsUploadsAndDeletesUserSkills', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-uskill-'));
    const service = new UserSkillService(dir);
    const existing = join(dir, '7', 'existing');
    mkdirSync(existing, { recursive: true });
    writeFileSync(join(existing, 'SKILL.md'), skill('existing', 'Existing', 'Body'));

    const list = service.listUserSkills(7);
    expect(list.map((s) => s.name)).toEqual(['existing']);

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

  it('returnsFailuresForInvalidUploadReadAndDeleteRequests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-uskill-'));
    const service = new UserSkillService(dir);
    expect(service.listUserSkills(7)).toEqual([]);
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
});
