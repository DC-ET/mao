import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { SkillLoader } from './skill-loader.js';
import { PathSandbox } from '../safety/path-sandbox.js';

describe('SkillLoader', () => {
  it('loadsSkillMdDocumentsAndInvalidatesCache', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-skills-'));
    mkdirSync(join(dir, 'demo'), { recursive: true });
    writeFileSync(join(dir, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: Demo skill\n---\nBody\n');
    const loader = new SkillLoader(new PathSandbox(dir), dir, 300);
    expect(loader.getAllNames()).toEqual(['demo']);
    expect(loader.hasSkill('demo')).toBe(true);
    expect(loader.getSkillFolder('demo')).toContain('demo');
    expect(loader.getCatalogWithPaths(['demo'])).toContain('demo');
    loader.invalidateCache();
    expect(loader.getAllDocuments()[0].body).toBe('Body');
  });
});
