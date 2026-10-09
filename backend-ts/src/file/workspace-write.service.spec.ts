import { spawn } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import { withFileLock } from '../harness/tool/impl/file-write-lock.js';
import type { ActivityService } from '../session/activity.service.js';
import { useTmpDir } from '../testing/tmp-dir.js';
import { copyLimits, WorkspaceWriteService } from './workspace-write.service.js';

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 15));
}

function setup() {
  const root = useTmpDir('mao-ws-write-');
  const sandbox = new PathSandbox(root);
  const workspace = join(root, 'user', 'sess');
  mkdirSync(workspace, { recursive: true });
  const recorded: unknown[][] = [];
  const activity = {
    record: vi.fn(async (...args: unknown[]) => {
      recorded.push(args);
      return { id: recorded.length };
    }),
  } as unknown as ActivityService;
  const service = new WorkspaceWriteService(sandbox, activity);
  return { root, sandbox, workspace, service, recorded, activity };
}

function codeOf(e: unknown): number {
  expect(e).toBeInstanceOf(BusinessException);
  return (e as BusinessException).code;
}

describe('workspace write service', () => {
  it('rejects path escape, allowed runtime roots, and symlinks that leave the workspace', async () => {
    const { sandbox, workspace, service, recorded } = setup();
    const runtime = useTmpDir('mao-ws-runtime-');
    sandbox.addAllowedRoot(runtime);
    const outside = useTmpDir('mao-ws-out-');
    writeFileSync(join(outside, 'secret'), 'keep');
    symlinkSync(outside, join(workspace, 'escape'));
    writeFileSync(join(workspace, 'inside.txt'), 'old');
    symlinkSync(join(outside, 'secret'), join(workspace, 'leak'));
    symlinkSync(join(workspace, 'inside.txt'), join(workspace, 'inner-link'));

    expect(codeOf(await service.write(1, workspace, '../outside.txt', 'x').catch((e) => e))).toBe(ErrorCode.FORBIDDEN.code);
    expect(codeOf(await service.write(1, workspace, join(runtime, 'note.txt'), 'x').catch((e) => e))).toBe(ErrorCode.FORBIDDEN.code);
    expect(codeOf(await service.write(1, workspace, 'escape/pwn.txt', 'x').catch((e) => e))).toBe(ErrorCode.FORBIDDEN.code);
    expect(codeOf(await service.write(1, workspace, 'leak', 'x').catch((e) => e))).toBe(ErrorCode.FORBIDDEN.code);
    expect(codeOf(await service.write(1, workspace, 'inner-link', 'x').catch((e) => e))).toBe(ErrorCode.PARAM_INVALID.code);
    expect(readFileSync(join(outside, 'secret'), 'utf8')).toBe('keep');
    expect(readFileSync(join(workspace, 'inside.txt'), 'utf8')).toBe('old');
    expect(recorded).toHaveLength(0);
  });

  it('creates, overwrites, and rejects existing targets', async () => {
    const { workspace, service, recorded } = setup();
    expect((await service.mkdir(1, workspace, 'a/b')).path).toBe('a/b');
    expect(codeOf(await service.mkdir(1, workspace, 'a/b').catch((e) => e))).toBe(ErrorCode.WORKSPACE_TARGET_EXISTS.code);
    expect((await service.write(1, workspace, 'a/b/c.txt', 'hi')).path).toBe('a/b/c.txt');
    expect(readFileSync(join(workspace, 'a/b/c.txt'), 'utf8')).toBe('hi');
    expect(codeOf(await service.write(1, workspace, 'a/b/c.txt', 'no').catch((e) => e))).toBe(ErrorCode.WORKSPACE_TARGET_EXISTS.code);
    expect(readFileSync(join(workspace, 'a/b/c.txt'), 'utf8')).toBe('hi');
    await service.write(1, workspace, 'a/b/c.txt', 'yes', { overwrite: true });
    expect(readFileSync(join(workspace, 'a/b/c.txt'), 'utf8')).toBe('yes');
    mkdirSync(join(workspace, 'dir-target'));
    expect(codeOf(await service.write(1, workspace, 'dir-target', 'x', { overwrite: true }).catch((e) => e))).toBe(ErrorCode.PARAM_INVALID.code);
    expect(recorded.length).toBeGreaterThan(0);
    expect(recorded[0][1]).toBe('file_user_write');
  });

  it('renames with exact byte names, including case-only changes', async () => {
    const { workspace, service } = setup();
    await service.write(1, workspace, 'Foo.txt', 'body');
    expect(codeOf(await service.rename(1, workspace, 'Foo.txt', ' Foo.txt').catch((e) => e))).toBe(ErrorCode.PARAM_INVALID.code);
    expect(codeOf(await service.rename(1, workspace, 'Foo.txt', '..').catch((e) => e))).toBe(ErrorCode.PARAM_INVALID.code);
    expect((await service.rename(1, workspace, 'Foo.txt', 'foo.txt')).path).toBe('foo.txt');
    expect(readFileSync(join(workspace, 'foo.txt'), 'utf8')).toBe('body');
    await service.write(1, workspace, 'taken.txt', 't');
    expect(codeOf(await service.rename(1, workspace, 'foo.txt', 'taken.txt', { overwrite: true }).catch((e) => e)))
      .toBe(ErrorCode.WORKSPACE_TARGET_EXISTS.code);
  });

  it('moves into a directory, rejects moving a directory into itself, and refuses the workspace root', async () => {
    const { workspace, service } = setup();
    await service.write(1, workspace, 'a.txt', 'a');
    await service.mkdir(1, workspace, 'box');
    expect((await service.move(1, workspace, 'a.txt', 'box')).path).toBe('box/a.txt');
    expect(readFileSync(join(workspace, 'box/a.txt'), 'utf8')).toBe('a');
    await service.mkdir(1, workspace, 'tree/child');
    expect(codeOf(await service.move(1, workspace, 'tree', 'tree/child').catch((e) => e))).toBe(ErrorCode.PARAM_INVALID.code);
    expect(codeOf(await service.delete(1, workspace, '.').catch((e) => e))).toBe(ErrorCode.PARAM_INVALID.code);
    expect(codeOf(await service.rename(1, workspace, '.', 'gone').catch((e) => e))).toBe(ErrorCode.PARAM_INVALID.code);
    expect(codeOf(await service.move(1, workspace, '.', 'box').catch((e) => e))).toBe(ErrorCode.PARAM_INVALID.code);
  });

  it('deletes files, directory trees, and symlink links without the target', async () => {
    const { workspace, service } = setup();
    await service.write(1, workspace, 'keep.txt', 'stay');
    symlinkSync(join(workspace, 'keep.txt'), join(workspace, 'link.txt'));
    await service.delete(1, workspace, 'link.txt');
    expect(readFileSync(join(workspace, 'keep.txt'), 'utf8')).toBe('stay');
    expect(() => lstatSync(join(workspace, 'link.txt'))).toThrow();
    await service.mkdir(1, workspace, 'gone/nested');
    await service.write(1, workspace, 'gone/nested/x.txt', 'x');
    await service.delete(1, workspace, 'gone');
    expect(() => lstatSync(join(workspace, 'gone'))).toThrow();
    expect(codeOf(await service.delete(1, workspace, 'missing.txt').catch((e) => e))).toBe(ErrorCode.PARAM_INVALID.code);
  });

  it('copies trees, keeps symlink links, and rejects copying a directory into itself', async () => {
    const { workspace, service } = setup();
    await service.mkdir(1, workspace, 'src/sub');
    await service.write(1, workspace, 'src/sub/a.txt', 'aaa');
    symlinkSync('a.txt', join(workspace, 'src/sub/rel'));
    expect((await service.copy(1, workspace, 'src', 'dst')).path).toBe('dst');
    expect(readFileSync(join(workspace, 'dst/sub/a.txt'), 'utf8')).toBe('aaa');
    expect(readlinkSync(join(workspace, 'dst/sub/rel'))).toBe('a.txt');
    expect(readFileSync(join(workspace, 'src/sub/a.txt'), 'utf8')).toBe('aaa');
    expect(codeOf(await service.copy(1, workspace, 'src', 'src/sub').catch((e) => e))).toBe(ErrorCode.PARAM_INVALID.code);
    await service.write(1, workspace, 'one.txt', '1');
    expect((await service.copy(1, workspace, 'one.txt', 'dst')).path).toBe('dst/one.txt');
    expect(codeOf(await service.copy(1, workspace, 'src', 'one.txt').catch((e) => e))).toBe(ErrorCode.PARAM_INVALID.code);
  });

  it('rejects copies that exceed the entry cap', async () => {
    const { workspace, service } = setup();
    const src = join(workspace, 'wide');
    mkdirSync(src);
    for (let i = 0; i < 3; i++) writeFileSync(join(src, `f${i}.txt`), 'x');
    const previous = copyLimits.entries;
    copyLimits.entries = 2;
    try {
      const failed = await service.copy(1, workspace, 'wide', 'partial').catch((e) => e);
      expect(codeOf(failed)).toBe(ErrorCode.PARAM_INVALID.code);
      expect((failed as BusinessException).message).toContain('下载-上传');
      expect(() => lstatSync(join(workspace, 'partial'))).toThrow();
    } finally {
      copyLimits.entries = previous;
    }
  });

  it('removes a partial destination when a copy fails midway', async () => {
    const { workspace, service } = setup();
    const src = join(workspace, 'wide');
    mkdirSync(src);
    writeFileSync(join(src, 'ok.txt'), 'ok');
    writeFileSync(join(src, 'secret.txt'), 'no');
    chmodSync(join(src, 'secret.txt'), 0);
    try {
      const failed = await service.copy(1, workspace, 'wide', 'partial').catch((e) => e);
      if (failed instanceof BusinessException || failed instanceof Error) {
        expect(() => lstatSync(join(workspace, 'partial'))).toThrow();
      }
    } finally {
      chmodSync(join(src, 'secret.txt'), 0o644);
    }
  });

  it('returns 3043 while an agent write is in flight and allows force', async () => {
    const { workspace, service, recorded } = setup();
    await service.write(1, workspace, 'src/a.txt', 'v1');
    const file = join(workspace, 'src/a.txt');
    let release!: () => void;
    const held = withFileLock(file, () => new Promise<void>((resolve) => { release = resolve; }));
    await tick();
    const conflict = await service.delete(1, workspace, 'src').catch((e) => e);
    expect(codeOf(conflict)).toBe(ErrorCode.WORKSPACE_WRITE_CONFLICT.code);
    expect((conflict as BusinessException).message).toContain('src/a.txt');
    expect((conflict as BusinessException).message.startsWith('Agent 正在写入：')).toBe(true);
    const forced = service.write(1, workspace, 'src/a.txt', 'forced', { overwrite: true, force: true });
    await tick();
    release();
    await held;
    await forced;
    expect(readFileSync(file, 'utf8')).toBe('forced');
    const before = recorded.length;
    await service.rename(1, workspace, 'missing', 'x').catch(() => undefined);
    expect(recorded).toHaveLength(before);
  });

  it('queues a forced upload behind an agent write of the same file', async () => {
    const { workspace, service } = setup();
    await service.write(1, workspace, 'src/a.txt', 'v1');
    const file = join(workspace, 'src/a.txt');
    let release!: () => void;
    const agent = withFileLock(file, () => new Promise<void>((resolve) => { release = resolve; }));
    await tick();
    const forced = service.upload(1, workspace, 'src', [
      { relativePath: 'a.txt', bytes: Buffer.from('forced') },
    ], { overwrite: true, force: true });
    await tick();
    expect(readFileSync(file, 'utf8')).toBe('v1');
    release();
    await agent;
    await forced;
    expect(readFileSync(file, 'utf8')).toBe('forced');
  });

  it('uploads under a directory and rejects relative traversal', async () => {
    const { workspace, service, recorded } = setup();
    const result = await service.upload(1, workspace, 'in', [
      { relativePath: 'docs/a.txt', bytes: Buffer.from('doc') },
      { relativePath: 'b.txt', bytes: Buffer.from('bee') },
    ]);
    expect(result.path).toBe('in');
    expect(readFileSync(join(workspace, 'in/docs/a.txt'), 'utf8')).toBe('doc');
    expect(readFileSync(join(workspace, 'in/b.txt'), 'utf8')).toBe('bee');
    const before = recorded.length;
    expect(codeOf(await service.upload(1, workspace, 'in', [{ relativePath: '../out.txt', bytes: Buffer.from('no') }]).catch((e) => e)))
      .toBe(ErrorCode.PARAM_INVALID.code);
    expect(() => lstatSync(join(workspace, 'out.txt'))).toThrow();
    expect(recorded).toHaveLength(before);
    const detail = JSON.parse(String(recorded[recorded.length - 1][4]));
    expect(detail).toMatchObject({ actor: 'user', op: 'upload' });
  });

  it('rejects an upload batch that names the same file twice when overwrite is off', async () => {
    const { workspace, service, recorded } = setup();
    const failed = await service.upload(1, workspace, 'in', [
      { relativePath: 'a.txt', bytes: Buffer.from('first') },
      { relativePath: 'a.txt', bytes: Buffer.from('second') },
    ]).catch((e) => e);
    expect(codeOf(failed)).toBe(ErrorCode.WORKSPACE_TARGET_EXISTS.code);
    expect(recorded).toHaveLength(0);
    let body = '';
    try {
      body = readFileSync(join(workspace, 'in/a.txt'), 'utf8');
    } catch {
      body = '';
    }
    expect(body).not.toBe('second');
  });

  it('deletes a symlink entry without touching an outside target', async () => {
    const { workspace, service } = setup();
    const outside = useTmpDir('mao-ws-out-');
    writeFileSync(join(outside, 'secret'), 'keep');
    symlinkSync(join(outside, 'secret'), join(workspace, 'leak'));
    await service.delete(1, workspace, 'leak');
    expect(() => lstatSync(join(workspace, 'leak'))).toThrow();
    expect(readFileSync(join(outside, 'secret'), 'utf8')).toBe('keep');
  });

  it('rejects deleting a directory while a queued agent write of a file inside it is running', async () => {
    const { workspace, service } = setup();
    await service.write(1, workspace, 'src/a.txt', 'v1');
    const file = join(workspace, 'src/a.txt');
    let release!: () => void;
    const first = withFileLock(file, () => new Promise<void>((resolve) => { release = resolve; }));
    await tick();
    let outcome: unknown = 'pending';
    const second = withFileLock(file, async () => {
      outcome = await service.delete(1, workspace, 'src').catch((e) => e);
    });
    await tick();
    release();
    await first;
    await second;
    expect(codeOf(outcome)).toBe(ErrorCode.WORKSPACE_WRITE_CONFLICT.code);
    expect(readFileSync(file, 'utf8')).toBe('v1');
  });

  it('blocks an agent write through a symlink while the user is deleting the real directory', async () => {
    const root = useTmpDir('mao-ws-write-');
    const sandbox = new PathSandbox(root);
    const workspace = join(root, 'user', 'sess');
    mkdirSync(workspace, { recursive: true });
    let blockRecord = false;
    let releaseRecord!: () => void;
    const activity = {
      record: vi.fn(() => {
        if (!blockRecord) return Promise.resolve({ id: 1 });
        return new Promise((resolve) => { releaseRecord = () => resolve({ id: 1 }); });
      }),
    } as unknown as ActivityService;
    const service = new WorkspaceWriteService(sandbox, activity);
    await service.write(1, workspace, 'src/a.txt', 'v1');
    symlinkSync(join(workspace, 'src'), join(workspace, 'link'));
    blockRecord = true;
    const deleting = service.delete(1, workspace, 'src');
    await tick();
    let wrote = false;
    const pending = withFileLock(join(workspace, 'link', 'a.txt'), async () => { wrote = true; });
    await tick();
    expect(wrote).toBe(false);
    releaseRecord();
    await deleting;
    await pending;
    expect(wrote).toBe(true);
  });

  it('rejects an upload that writes through a symlink into a file an agent is creating', async () => {
    const { workspace, service } = setup();
    await service.mkdir(1, workspace, 'src');
    await service.mkdir(1, workspace, 'inbox');
    symlinkSync(join(workspace, 'src'), join(workspace, 'inbox/link'));
    const file = join(workspace, 'src/sub/a.txt');
    let release!: () => void;
    const agent = withFileLock(file, () => new Promise<void>((resolve) => { release = resolve; }));
    await tick();
    const failed = await service.upload(1, workspace, 'inbox', [
      { relativePath: 'link/sub/a.txt', bytes: Buffer.from('user') },
    ]).catch((e) => e);
    const during = await import('node:fs').then((fs) => {
      try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
    });
    release();
    await agent;
    expect(codeOf(failed)).toBe(ErrorCode.WORKSPACE_WRITE_CONFLICT.code);
    expect(during).toBeNull();
  });

  it('rejects an upload batch whose different relative paths alias one file', async () => {
    const { workspace, service } = setup();
    await service.mkdir(1, workspace, 'src');
    await service.mkdir(1, workspace, 'inbox');
    symlinkSync(join(workspace, 'src'), join(workspace, 'inbox/link1'));
    symlinkSync(join(workspace, 'src'), join(workspace, 'inbox/link2'));
    const failed = await service.upload(1, workspace, 'inbox', [
      { relativePath: 'link1/sub/a.txt', bytes: Buffer.from('first') },
      { relativePath: 'link2/sub/a.txt', bytes: Buffer.from('second') },
    ]).catch((e) => e);
    expect(codeOf(failed)).toBe(ErrorCode.WORKSPACE_TARGET_EXISTS.code);
    let body = '';
    try {
      body = readFileSync(join(workspace, 'src/sub/a.txt'), 'utf8');
    } catch {
      body = '';
    }
    expect(body).not.toBe('second');
  });

  it('rejects an upload that names a file and a path under that file', async () => {
    const { workspace, service, recorded } = setup();
    const failed = await service.upload(1, workspace, 'in', [
      { relativePath: 'sub', bytes: Buffer.from('file') },
      { relativePath: 'sub/a.txt', bytes: Buffer.from('child') },
    ]).catch((e) => e);
    let left = true;
    try { lstatSync(join(workspace, 'in/sub')); } catch { left = false; }
    expect(left).toBe(false);
    expect(failed).toBeInstanceOf(BusinessException);
    expect(recorded).toHaveLength(0);
  });

  it('blocks a new agent write while an upload through a symlink still holds the target', async () => {
    const root = useTmpDir('mao-ws-write-');
    const sandbox = new PathSandbox(root);
    const workspace = join(root, 'user', 'sess');
    mkdirSync(workspace, { recursive: true });
    let blockRecord = false;
    let releaseRecord!: () => void;
    const activity = {
      record: vi.fn(() => {
        if (!blockRecord) return Promise.resolve({ id: 1 });
        return new Promise((resolve) => { releaseRecord = () => resolve({ id: 1 }); });
      }),
    } as unknown as ActivityService;
    const service = new WorkspaceWriteService(sandbox, activity);
    await service.mkdir(1, workspace, 'src');
    await service.mkdir(1, workspace, 'inbox');
    symlinkSync(join(workspace, 'src'), join(workspace, 'inbox/link'));
    blockRecord = true;
    let uploadError: unknown = null;
    const uploading = service.upload(1, workspace, 'inbox', [
      { relativePath: 'link/sub/a.txt', bytes: Buffer.from('user') },
    ]).catch((e) => { uploadError = e; });
    await tick();
    expect(uploadError).toBeNull();
    expect(typeof releaseRecord).toBe('function');
    expect(readFileSync(join(workspace, 'src/sub/a.txt'), 'utf8')).toBe('user');
    let ran = false;
    const agent = withFileLock(join(workspace, 'src/sub/a.txt'), async () => {
      ran = true;
      writeFileSync(join(workspace, 'src/sub/a.txt'), 'agent');
    });
    await tick();
    expect(readFileSync(join(workspace, 'src/sub/a.txt'), 'utf8')).toBe('user');
    expect(ran).toBe(false);
    releaseRecord();
    await uploading;
    await agent;
    expect(ran).toBe(true);
  });

  it('rejects copying a directory into itself through a symlink', async () => {
    const workspace = useTmpDir('mao-ws-write-');
    mkdirSync(join(workspace, 'dir/sub'), { recursive: true });
    writeFileSync(join(workspace, 'dir/a.txt'), 'a');
    symlinkSync(join(workspace, 'dir/sub'), join(workspace, 'link'));
    const script = `
      import { WorkspaceWriteService } from ${JSON.stringify(join(process.cwd(), 'src/file/workspace-write.service.ts'))};
      import { PathSandbox } from ${JSON.stringify(join(process.cwd(), 'src/harness/safety/path-sandbox.ts'))};
      const workspace = process.argv[2];
      const service = new WorkspaceWriteService(new PathSandbox(workspace), { record: async () => ({ id: 1 }) });
      try {
        await service.copy(1, workspace, 'dir', 'link/nested');
        console.log('DONE');
      } catch (e) {
        console.log('ERR ' + (e && e.name) + ' ' + (e && e.message));
      }
    `;
    const scriptPath = join(workspace, 'run.mts');
    writeFileSync(scriptPath, script);
    const child = spawn(join(process.cwd(), 'node_modules/.bin/tsx'), [scriptPath, workspace], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    const nested = join(workspace, 'dir/sub/nested/sub');
    let sawNested = false;
    try {
      const started = Date.now();
      while (Date.now() - started < 1500) {
        try {
          lstatSync(nested);
          sawNested = true;
          break;
        } catch {
          // 还没嵌套进源目录
        }
        if (child.exitCode != null) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(sawNested).toBe(false);
      expect(readFileSync(join(workspace, 'dir/a.txt'), 'utf8')).toBe('a');
    } finally {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      peelNestedCopy(join(workspace, 'dir/sub'));
    }
  });
});

/** 复制进自身会叠出很长的 nested/sub 链，按层改短名再删，避免清临时目录时路径过长。 */
function peelNestedCopy(subDir: string): void {
  const nested = join(subDir, 'nested');
  const hold = join(subDir, 'hold');
  for (let i = 0; i < 10000; i++) {
    let has = false;
    try { lstatSync(nested); has = true; } catch { has = false; }
    if (!has) return;
    const inner = join(nested, 'sub');
    let moved = false;
    try {
      lstatSync(inner);
      renameSync(inner, hold);
      moved = true;
    } catch {
      moved = false;
    }
    rmSync(nested, { recursive: true, force: true });
    if (!moved) return;
    renameSync(hold, nested);
  }
}
