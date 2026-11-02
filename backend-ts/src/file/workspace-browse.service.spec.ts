import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { ErrorCode } from '../common/error-code.js';
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
    // 结果 path 相对工作区根，workspaceRoot 供前端拼绝对路径（复制绝对路径）
    expect(result.workspaceRoot).toBe(resolve(ws));
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

describe('WorkspaceBrowseService.listDirectory', () => {
  let cleanup: (() => void) | null = null;

  function createService(): { service: WorkspaceBrowseService; ws: string } {
    const root = mkdtempSync(join(tmpdir(), 'mao-browse-list-'));
    cleanup = () => rmSync(root, { recursive: true, force: true });
    const ws = join(root, 'ws');
    mkdirSync(ws, { recursive: true });
    return { service: new WorkspaceBrowseService(new PathSandbox(root)), ws };
  }

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('returnsMtimeMsForEntries', () => {
    const { service, ws } = createService();
    writeFileSync(join(ws, 'a.txt'), 'x');
    mkdirSync(join(ws, 'sub'));

    const result = service.listDirectory(ws, '');
    const file = result.entries.find((e) => e.name === 'a.txt');
    const dir = result.entries.find((e) => e.name === 'sub');
    expect(file?.mtimeMs).toBeGreaterThan(0);
    expect(dir?.mtimeMs).toBeGreaterThan(0);
    expect(file?.size).toBe(1);
    expect(dir?.isDirectory).toBe(true);
  });

  it('keepsSymlinkFlagAndSortsDirectoriesFirst', () => {
    const { service, ws } = createService();
    writeFileSync(join(ws, 'a.txt'), 'x');
    mkdirSync(join(ws, 'zdir'));
    symlinkSync(join(ws, 'a.txt'), join(ws, 'link.txt'));
    const result = service.listDirectory(ws, '');
    expect(result.entries.map((e) => e.name)).toEqual(['zdir', 'a.txt', 'link.txt']);
    expect(result.entries.find((e) => e.name === 'link.txt')?.isSymlink).toBe(true);
    expect(result.entries.find((e) => e.name === 'zdir')?.isSymlink).toBe(false);
  });

  it('returnsWorkspaceRootAsAbsolutePathOfSessionWorkspace', () => {
    const { service, ws } = createService();
    writeFileSync(join(ws, 'a.txt'), 'x');
    const result = service.listDirectory(ws, '');
    expect(result.workspaceRoot).toBe(resolve(ws));
    // 子目录同样以工作区根为基准，不随 dir 参数漂移
    mkdirSync(join(ws, 'sub'));
    expect(service.listDirectory(ws, 'sub').workspaceRoot).toBe(resolve(ws));
  });
});

describe('WorkspaceBrowseService experience mount', () => {
  let cleanup: (() => void) | null = null;

  function layout() {
    const root = mkdtempSync(join(tmpdir(), 'mao-browse-exp-'));
    cleanup = () => rmSync(root, { recursive: true, force: true });
    const ws = join(root, 'ws');
    const lib = join(root, 'share', 'agent-experience', '9');
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(lib, { recursive: true });
    mkdirSync(ws, { recursive: true });
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(lib, 'INDEX.md'), '# index\n');
    writeFileSync(join(lib, '2026-11-02-note.md'), 'note body');
    writeFileSync(join(elsewhere, 'secret.txt'), 'nope');
    symlinkSync(lib, join(ws, '团队经验'), 'dir');
    symlinkSync(elsewhere, join(ws, 'leak'), 'dir');
    return { root, ws, lib, elsewhere, service: new WorkspaceBrowseService(new PathSandbox(root)) };
  }

  afterEach(() => {
    cleanup?.();
    cleanup = null;
  });

  it('listsReadsAndSearchesTheGrantedLibrary', async () => {
    const { service, ws, lib } = layout();
    const listing = service.listDirectory(ws, '', lib);
    expect(listing.readOnly).toBeUndefined();
    expect(listing.entries.find((e) => e.name === '团队经验')).toMatchObject({
      isDirectory: true,
      isSymlink: true,
      path: '团队经验',
    });

    const inside = service.listDirectory(ws, '团队经验', lib);
    expect(inside.readOnly).toBe(true);
    expect(inside.entries.map((e) => e.name).sort()).toEqual(['2026-11-02-note.md', 'INDEX.md']);

    const content = await service.readFile(ws, '团队经验/2026-11-02-note.md', 0, 20, lib);
    expect(content.content).toBe('note body');

    const found = service.searchFiles(ws, 'note', 20, lib);
    expect(found.entries.map((e) => e.path)).toContain('团队经验/2026-11-02-note.md');
    expect(found.entries.some((e) => e.path.startsWith('leak/'))).toBe(false);
  });

  it('rejectsOtherSymlinksAndARetargetedMount', async () => {
    const { service, ws, lib, root } = layout();
    await expect(service.readFile(ws, 'leak/secret.txt', 0, 10, lib))
      .rejects.toMatchObject({ code: ErrorCode.FORBIDDEN.code });
    await expect(service.readFile(ws, '团队经验/../../elsewhere/secret.txt', 0, 10, lib))
      .rejects.toMatchObject({ code: ErrorCode.FORBIDDEN.code });

    rmSync(join(ws, '团队经验'));
    const hijacked = join(root, 'hijacked');
    mkdirSync(hijacked);
    writeFileSync(join(hijacked, 'x.md'), 'x');
    symlinkSync(hijacked, join(ws, '团队经验'), 'dir');

    await expect(service.readFile(ws, '团队经验/x.md', 0, 10, lib))
      .rejects.toMatchObject({ code: ErrorCode.FORBIDDEN.code });
    const listing = service.listDirectory(ws, '', lib);
    expect(listing.entries.find((e) => e.name === '团队经验')?.isDirectory).toBe(false);
  });

  it('without a grant the mount stays forbidden', async () => {
    const { service, ws } = layout();
    await expect(service.readFile(ws, '团队经验/INDEX.md', 0, 10))
      .rejects.toMatchObject({ code: ErrorCode.FORBIDDEN.code });
    const listing = service.listDirectory(ws, '');
    expect(listing.entries.find((e) => e.name === '团队经验')?.isDirectory).toBe(false);
  });
});
