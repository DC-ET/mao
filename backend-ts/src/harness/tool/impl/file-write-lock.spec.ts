import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { useTmpDir } from '../../../testing/tmp-dir.js';
import {
  conflictingWritePaths,
  FileWriteConflict,
  holdDirectories,
  withFileLock,
  withUserFileLocks,
} from './file-write-lock.js';

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe('file write lock', () => {
  it('treats a queued write as in flight and releases after the callback', async () => {
    const dir = useTmpDir('mao-lock-');
    const file = join(dir, 'a.txt');
    let release!: () => void;
    const held = withFileLock(file, () => new Promise<void>((resolve) => { release = resolve; }));
    await tick();
    expect(conflictingWritePaths([file])).toEqual([file]);
    release();
    await held;
    expect(conflictingWritePaths([file])).toEqual([]);
  });

  it('reports a child write when the candidate is the parent directory', async () => {
    const dir = useTmpDir('mao-lock-');
    const folder = join(dir, 'src');
    const file = join(folder, 'a.txt');
    mkdirSync(folder);
    let release!: () => void;
    const held = withFileLock(file, () => new Promise<void>((resolve) => { release = resolve; }));
    await tick();
    expect(conflictingWritePaths([folder]).length).toBeGreaterThan(0);
    let rejected = false;
    try {
      await withUserFileLocks([file], false, async () => undefined);
    } catch (e) {
      rejected = e instanceof FileWriteConflict;
    }
    expect(rejected).toBe(true);
    release();
    await held;
    await withUserFileLocks([file], false, async () => undefined);
  });

  it('holds a directory so a new file lock waits until release', async () => {
    const dir = useTmpDir('mao-lock-');
    const folder = join(dir, 'src');
    const file = join(folder, 'a.txt');
    mkdirSync(folder);
    writeFileSync(file, 'x');
    const hold = holdDirectories([folder], false);
    let ran = false;
    const pending = withFileLock(file, async () => { ran = true; });
    await tick();
    expect(ran).toBe(false);
    hold.release();
    await pending;
    expect(ran).toBe(true);
  });

  it('serializes two writers on the same path', async () => {
    const dir = useTmpDir('mao-lock-');
    const file = join(dir, 'a.txt');
    const order: string[] = [];
    let release!: () => void;
    const first = withFileLock(file, () => new Promise<void>((resolve) => {
      order.push('agent-start');
      release = resolve;
    }));
    await tick();
    const second = withUserFileLocks([file], true, async () => {
      order.push('user');
    });
    await tick();
    expect(order).toEqual(['agent-start']);
    release();
    await first;
    await second;
    expect(order).toEqual(['agent-start', 'user']);
  });

  it('keeps a queued write visible after the previous holder releases the path', async () => {
    const dir = useTmpDir('mao-lock-');
    const file = join(dir, 'a.txt');
    let release!: () => void;
    const first = withFileLock(file, () => new Promise<void>((resolve) => { release = resolve; }));
    await tick();
    let visibleDuringSecond = false;
    const second = withFileLock(file, async () => {
      visibleDuringSecond = conflictingWritePaths([file]).includes(file);
    });
    await tick();
    release();
    await first;
    await second;
    expect(visibleDuringSecond).toBe(true);
  });

  it('blocks a new write through a symlink while the real directory is held', async () => {
    const dir = useTmpDir('mao-lock-');
    const folder = join(dir, 'src');
    const file = join(folder, 'a.txt');
    mkdirSync(folder);
    writeFileSync(file, 'x');
    const link = join(dir, 'link');
    symlinkSync(folder, link);
    const hold = holdDirectories([folder], false);
    let ran = false;
    const pending = withFileLock(join(link, 'a.txt'), async () => { ran = true; });
    await tick();
    expect(ran).toBe(false);
    hold.release();
    await pending;
    expect(ran).toBe(true);
  });

  it('blocks a new file through a chain of symlinks while the real directory is held', async () => {
    const dir = useTmpDir('mao-lock-');
    const folder = join(dir, 'src');
    mkdirSync(folder);
    const mid = join(dir, 'mid');
    const link = join(dir, 'link');
    symlinkSync(folder, mid);
    symlinkSync(mid, link);
    const hold = holdDirectories([folder], false);
    let ran = false;
    const pending = withFileLock(join(link, 'new.txt'), async () => { ran = true; });
    await tick();
    expect(ran).toBe(false);
    hold.release();
    await pending;
    expect(ran).toBe(true);
  });

  it('still queues a forced write when the agent holds the same file via a symlink', async () => {
    const dir = useTmpDir('mao-lock-');
    const folder = join(dir, 'src');
    const file = join(folder, 'a.txt');
    mkdirSync(folder);
    writeFileSync(file, 'x');
    const link = join(dir, 'link');
    symlinkSync(folder, link);
    let release!: () => void;
    const agent = withFileLock(join(link, 'a.txt'), () => new Promise<void>((resolve) => { release = resolve; }));
    await tick();
    let ran = false;
    const user = withUserFileLocks([file], true, async () => { ran = true; });
    await tick();
    expect(ran).toBe(false);
    release();
    await agent;
    await user;
    expect(ran).toBe(true);
  });
});
