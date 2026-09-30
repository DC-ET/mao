import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import { WorkspaceBrowseService } from './workspace-browse.service.js';

describe('WorkspaceBrowseService.searchFiles', () => {
  let cleanup: (() => void) | null = null;

  function createService(): { service: WorkspaceBrowseService; ws: string } {
    const root = mkdtempSync(join(tmpdir(), 'mao-browse-search-'));
    cleanup = () => rmSync(root, { recursive: true, force: true });
    const ws = join(root, 'ws');
    mkdirSync(ws, { recursive: true });
    return { service: new WorkspaceBrowseService(new PathSandbox(root)), ws };
  }

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('recursivelyMatchesFileNamesCaseInsensitive', () => {
    const { service, ws } = createService();
    mkdirSync(join(ws, 'amber-acg', 'src', 'main'), { recursive: true });
    writeFileSync(join(ws, 'amber-acg', 'src', 'main', 'UserService.java'), 'x');
    writeFileSync(join(ws, 'README.md'), 'x');

    const result = service.searchFiles(ws, 'userservice', 100);
    expect(result.truncated).toBe(false);
    expect(result.entries.map((e) => e.path)).toEqual(['amber-acg/src/main/UserService.java']);
    expect(result.entries[0].size).toBe(1);
  });

  it('skipsGitNodeModulesAndSymlinkedDirs', () => {
    const { service, ws } = createService();
    mkdirSync(join(ws, '.git'), { recursive: true });
    writeFileSync(join(ws, '.git', 'config.lock'), 'x');
    mkdirSync(join(ws, 'app', 'node_modules'), { recursive: true });
    writeFileSync(join(ws, 'app', 'node_modules', 'left-pad.js'), 'x');
    mkdirSync(join(ws, 'app', 'real'), { recursive: true });
    writeFileSync(join(ws, 'app', 'real', 'config.lock'), 'x');
    mkdirSync(join(ws, 'linked-target'), { recursive: true });
    writeFileSync(join(ws, 'linked-target', 'config.lock'), 'x');
    symlinkSync(join(ws, 'linked-target'), join(ws, 'linked'));

    // 符号链接本身不进入遍历（无 linked/config.lock），但真实目录 linked-target 正常搜索
    const result = service.searchFiles(ws, 'config.lock', 100);
    expect(result.entries.map((e) => e.path)).toEqual(['app/real/config.lock', 'linked-target/config.lock']);
    expect(result.entries.some((e) => e.path.startsWith('linked/'))).toBe(false);
  });

  it('marksTruncatedWhenResultLimitReached', () => {
    const { service, ws } = createService();
    for (let i = 0; i < 5; i++) writeFileSync(join(ws, `report-${i}.txt`), 'x');

    const result = service.searchFiles(ws, 'report', 3);
    expect(result.entries).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it('returnsEmptyForNoMatch', () => {
    const { service, ws } = createService();
    writeFileSync(join(ws, 'a.txt'), 'x');
    const result = service.searchFiles(ws, 'zzz-not-exist', 100);
    expect(result.entries).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });

  it('rejectsBlankPattern', () => {
    const { service, ws } = createService();
    expect(() => service.searchFiles(ws, '   ', 100)).toThrow();
  });
});
