import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectGrepFiles } from './grep-search-tool.js';

describe('collectGrepFiles', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('skips symlinks, dangling links, and link loops', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'mao-grep-'));
    dirs.push(root);
    await writeFile(path.join(root, 'ok.txt'), 'hello');
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'nested', 'inner.txt'), 'inner');
    await symlink(path.join(root, 'missing-target'), path.join(root, 'dangling'));
    await symlink(root, path.join(root, 'loop'));
    await symlink(path.join(root, 'ok.txt'), path.join(root, 'alias.txt'));

    const files: string[] = [];
    for await (const file of collectGrepFiles(root, null, root)) files.push(file);

    expect(files.some((file) => file.endsWith(`${path.sep}ok.txt`))).toBe(true);
    expect(files.some((file) => file.endsWith(`${path.sep}inner.txt`))).toBe(true);
    expect(files.some((file) => file.includes('dangling') || file.includes('loop') || file.endsWith('alias.txt'))).toBe(false);
  });
});
