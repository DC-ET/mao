import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PathEscapeError, isUnder, isWorkspaceWithin, resolvePathLenient, resolveSandboxPath } from '../src/local/sandbox';
import { resolveRuntimeDir } from '../src/local/paths';
import { handleEditFile, handleReadFile, handleWriteFile } from '../src/local/tools/files';
import { handleGlobSearch, handleGrepSearch } from '../src/local/tools/search';

const SESSION_ID = 777;

let workspace: string;
let outside: string;

beforeEach(() => {
  workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mao-sandbox-ws-')));
  outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mao-sandbox-out-')));
});

afterEach(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

describe('isUnder', () => {
  it('matches the backend PathSandbox semantics', () => {
    expect(isUnder('/a/b', '/a')).toBe(true);
    expect(isUnder('/a', '/a')).toBe(true);
    expect(isUnder('/ab', '/a')).toBe(false);
    expect(isUnder('/a/../b', '/a')).toBe(false);
  });
});

describe('resolveSandboxPath', () => {
  it('resolves relative paths against the workspace', () => {
    expect(resolveSandboxPath('src/a.ts', workspace, SESSION_ID)).toBe(path.join(workspace, 'src/a.ts'));
  });

  it('rejects traversal out of the workspace', () => {
    expect(() => resolveSandboxPath('../../etc/passwd', workspace, SESSION_ID)).toThrow(PathEscapeError);
  });

  it('rejects absolute paths outside the workspace', () => {
    expect(() => resolveSandboxPath('/etc/shadow', workspace, SESSION_ID)).toThrow(/拒绝访问工作区外路径/);
  });

  it('rejects ~ expansion escaping the workspace', () => {
    expect(() => resolveSandboxPath('~/.ssh/id_rsa', workspace, SESSION_ID)).toThrow(PathEscapeError);
  });

  it('rejects symlinks pointing outside the workspace', () => {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret\n');
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(workspace, 'link.txt'));
    expect(() => resolveSandboxPath('link.txt', workspace, SESSION_ID)).toThrow(PathEscapeError);
  });

  it('rejects paths under a symlinked directory that escapes', () => {
    fs.mkdirSync(path.join(outside, 'deep'), { recursive: true });
    fs.symlinkSync(path.join(outside, 'deep'), path.join(workspace, 'escape'));
    expect(() => resolveSandboxPath('escape/new-file.txt', workspace, SESSION_ID)).toThrow(PathEscapeError);
  });

  it('allows the session runtime dir as an extra root', () => {
    const runtimeFile = path.join(resolveRuntimeDir(SESSION_ID), 'skills', 'demo', 'SKILL.md');
    expect(resolveSandboxPath(runtimeFile, workspace, SESSION_ID)).toBe(runtimeFile);
  });

  it('rejects another session runtime dir', () => {
    const other = path.join(resolveRuntimeDir(SESSION_ID + 1), 'skills');
    expect(() => resolveSandboxPath(other, workspace, SESSION_ID)).toThrow(PathEscapeError);
  });

  it('requires a workspace', () => {
    expect(() => resolveSandboxPath('a.txt', undefined, SESSION_ID)).toThrow(/没有本地工作区/);
  });
});

describe('resolvePathLenient', () => {
  it('resolves relative paths against the workspace', () => {
    expect(resolvePathLenient('src/a.ts', workspace)).toBe(path.join(workspace, 'src/a.ts'));
  });

  it('allows absolute paths outside the workspace', () => {
    expect(resolvePathLenient(path.join(outside, 'note.txt'), workspace)).toBe(path.join(outside, 'note.txt'));
  });

  it('expands ~ and allows it outside the workspace', () => {
    expect(resolvePathLenient('~/note.txt', workspace)).toBe(path.join(os.homedir(), 'note.txt'));
  });

  it('does not require a workspace', () => {
    expect(resolvePathLenient('~/note.txt', undefined)).toBe(path.join(os.homedir(), 'note.txt'));
  });

  it('rejects empty paths', () => {
    expect(() => resolvePathLenient('   ', workspace)).toThrow(PathEscapeError);
  });
});

describe('isWorkspaceWithin', () => {
  it('accepts the workspace itself and its subdirectories', () => {
    fs.mkdirSync(path.join(workspace, 'sub'));
    expect(isWorkspaceWithin(workspace, workspace)).toBe(true);
    expect(isWorkspaceWithin(path.join(workspace, 'sub'), workspace)).toBe(true);
  });

  it('rejects parents and siblings', () => {
    expect(isWorkspaceWithin('/', workspace)).toBe(false);
    expect(isWorkspaceWithin(outside, workspace)).toBe(false);
  });
});

describe('file tools honour the sandbox', () => {
  it('read refuses to escape the workspace', () => {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
    const rel = path.relative(workspace, path.join(outside, 'secret.txt'));
    expect(String(handleReadFile({ path: rel }, workspace, SESSION_ID).content)).toMatch(/拒绝访问工作区外路径/);
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('secret\n');
  });

  it('write_file / edit_file may reach outside the workspace', async () => {
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
    const outsidePath = path.join(outside, 'outside-write.txt');
    const res = await handleWriteFile({ path: outsidePath, content: 'x\n' }, workspace, SESSION_ID);
    expect(res.success).toBe(true);
    expect(fs.readFileSync(outsidePath, 'utf8')).toBe('x\n');

    const edited = await handleEditFile(
      { path: outsidePath, old_string: 'x', new_string: 'y' },
      workspace,
      SESSION_ID,
    );
    expect(edited.success).toBe(true);
    expect(fs.readFileSync(outsidePath, 'utf8')).toBe('y\n');

    // 相对路径仍基于工作区解析
    const rel = await handleWriteFile({ path: 'inside.txt', content: 'z\n' }, workspace, SESSION_ID);
    expect(rel.success).toBe(true);
    expect(fs.readFileSync(path.join(workspace, 'inside.txt'), 'utf8')).toBe('z\n');
    const relEdit = await handleEditFile(
      { path: 'inside.txt', old_string: 'z', new_string: 'w' },
      workspace,
      SESSION_ID,
    );
    expect(relEdit.success).toBe(true);
    expect(fs.readFileSync(path.join(workspace, 'inside.txt'), 'utf8')).toBe('w\n');
  });

  it('refuses to follow symlinked files', async () => {
    fs.writeFileSync(path.join(workspace, 'real.txt'), 'inside\n');
    fs.symlinkSync(path.join(workspace, 'real.txt'), path.join(workspace, 'alias.txt'));
    expect(String(handleReadFile({ path: 'alias.txt' }, workspace, SESSION_ID).content)).toMatch(/拒绝操作符号链接/);
    expect(String((await handleWriteFile({ path: 'alias.txt', content: 'x' }, workspace, SESSION_ID)).error)).toMatch(/拒绝操作符号链接/);
    expect(String((await handleEditFile({ path: 'alias.txt', old_string: 'inside', new_string: 'x' }, workspace, SESSION_ID)).error))
      .toMatch(/拒绝操作符号链接/);
  });

  it('search tools refuse roots outside the workspace', async () => {
    const glob = await handleGlobSearch({ pattern: '*', path: outside }, workspace, SESSION_ID);
    expect(String(glob.error)).toMatch(/拒绝访问工作区外路径/);
    const grep = await handleGrepSearch({ pattern: 'x', path: '../..' }, workspace, SESSION_ID);
    expect(String(grep.error)).toMatch(/拒绝访问工作区外路径/);
  });
});
