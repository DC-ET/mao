import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectGrepFiles, GrepSearchTool } from './grep-search-tool.js';
import { PathSandbox } from '../../safety/path-sandbox.js';

const spawnSyncMock = vi.hoisted(() => vi.fn());
// 文件级 mock：collectGrepFiles 用例不触达 spawnSync，不受影响
vi.mock('node:child_process', () => ({ spawnSync: spawnSyncMock }));

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

describe('GrepSearchTool.searchWithRg（rg 进程失败不得吞成 0 命中）', () => {
  const dirs: string[] = [];

  afterEach(() => {
    spawnSyncMock.mockReset();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function makeTool(workspace: string): GrepSearchTool {
    return new GrepSearchTool(new PathSandbox(workspace));
  }

  it('非法正则（rg exit 2）返回 error，而不是干净的 0 命中成功', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mao-grep-rg-'));
    dirs.push(root);
    writeFileSync(path.join(root, 'a.txt'), 'hello world');
    // isRgAvailable()：rg --version 成功 → 走 rg 分支；搜索调用：非法正则 exit 2，错误只写 stderr
    spawnSyncMock.mockImplementation((_cmd: unknown, args: string[]) => {
      if (Array.isArray(args) && args[0] === '--version') return { status: 0, stdout: 'ripgrep 14.0.0' };
      return { status: 2, stdout: '', stderr: 'regex parse error' };
    });

    const out = JSON.parse(await makeTool(root).execute(JSON.stringify({ pattern: '[abc' }), root)) as { error?: string };

    expect(out.error).toContain('ripgrep 搜索失败');
  });

  it('rg 被超时/缓冲上限杀死且有部分 stdout 时 truncated 为 true', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mao-grep-rg-timeout-'));
    dirs.push(root);
    const partial = JSON.stringify({
      type: 'match', data: { path: { text: 'big.log' }, line_number: 1, lines: { text: 'needle here\n' } },
    });
    spawnSyncMock.mockImplementation((_cmd: unknown, args: string[]) => {
      if (Array.isArray(args) && args[0] === '--version') return { status: 0, stdout: 'ripgrep 14.0.0' };
      return { status: null, error: Object.assign(new Error('spawn ETIMEDOUT'), { code: 'ETIMEDOUT' }), stdout: partial, stderr: '' };
    });

    const out = JSON.parse(await makeTool(root).execute(JSON.stringify({ pattern: 'needle' }), root)) as { truncated?: boolean; matches?: unknown[] };

    expect(out.truncated).toBe(true);
    expect(out.matches).toHaveLength(1);
  });

  it('rg exit 1（无匹配）不是失败，返回干净的 0 命中', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'mao-grep-rg-nomatch-'));
    dirs.push(root);
    spawnSyncMock.mockImplementation((_cmd: unknown, args: string[]) => {
      if (Array.isArray(args) && args[0] === '--version') return { status: 0, stdout: 'ripgrep 14.0.0' };
      return { status: 1, stdout: '', stderr: '' };
    });

    const out = JSON.parse(await makeTool(root).execute(JSON.stringify({ pattern: 'zzz' }), root)) as { error?: string; total_matches?: number; truncated?: boolean };

    expect(out.error).toBeUndefined();
    expect(out.total_matches).toBe(0);
    expect(out.truncated).toBe(false);
  });
});
