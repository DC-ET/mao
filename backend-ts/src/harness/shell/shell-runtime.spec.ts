import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { PathSandbox } from '../safety/path-sandbox.js';
import { RuntimeDataResolver } from '../runtime/runtime-data-resolver.js';
import { OutputManager, ShellSessionManager } from './shell-session-manager.js';

describe('ShellSessionManager', () => {
  it('shellSessionManagerCreatesListsAndClosesRealShellSessions', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-shell-'));
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    const manager = new ShellSessionManager(
      new PathSandbox(dir),
      RuntimeDataResolver.forTest(join(dir, 'runtime'), join(dir, 'users')),
    );
    const session = manager.getOrCreate(11, 'sh-test', 7, dir, { 'git.example.com': 'tok' });
    expect(session.sessionId).toBe('sh-test');
    expect(session.isAlive()).toBe(true);
    expect(session.process.pid).toBeGreaterThan(0);
    expect(manager.getSession('sh-test')).toBe(session);
    expect(manager.listByConversation(11)).toContain(session);
    expect(manager.getActiveSessionCount()).toBe(1);
    const same = manager.getOrCreate(11, 'sh-test', 7, dir, {});
    expect(same).toBe(session);
    manager.close('sh-test');
    expect(manager.getSession('sh-test')).toBeNull();
    expect(session.isAlive()).toBe(false);
  });

  it('serializes commands on a shared shell session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-shell-'));
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    mkdirSync(join(dir, 'users'), { recursive: true });
    const manager = new ShellSessionManager(
      new PathSandbox(dir), RuntimeDataResolver.forTest(join(dir, 'runtime'), join(dir, 'users')),
    );
    const session = manager.getOrCreate(1, null, 1, dir);
    const releaseFirst = await session.acquireCommand();
    let secondAcquired = false;
    const second = session.acquireCommand().then((release) => { secondAcquired = true; release(); });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(secondAcquired).toBe(false);
    releaseFirst();
    await second;
    expect(secondAcquired).toBe(true);
    manager.close(session.sessionId);
  });

  it('ignores asynchronous pipe errors after closing a shell session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-shell-'));
    const manager = new ShellSessionManager(
      new PathSandbox(dir),
      RuntimeDataResolver.forTest(join(dir, 'runtime'), join(dir, 'users')),
    );
    const session = manager.getOrCreate(11, 'sh-reset', 7, dir, {});

    manager.close('sh-reset');

    expect(() => session.process.stdin.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).not.toThrow();
    expect(() => session.process.stdout.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))).not.toThrow();
  });

  it('injects GIT_TOKEN env vars and GIT_ASKPASS for user credentials', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-shell-'));
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    mkdirSync(join(dir, 'users'), { recursive: true });
    const manager = new ShellSessionManager(
      new PathSandbox(dir),
      RuntimeDataResolver.forTest(join(dir, 'runtime'), join(dir, 'users')),
    );
    const session = manager.getOrCreate(11, 'sh-git', 7, dir, { 'git.example.com': 'secret-token' });
    const output = new OutputManager();
    session.writeStdin('printf "%s\\n" "$GIT_TOKEN_git_example_com" "$GIT_ASKPASS" "$GIT_TERMINAL_PROMPT"\necho __DONE__\n');
    const result = await output.readUntilMarker(session, '__DONE__', 5000);
    const lines = result.output.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    expect(lines[0]).toBe('secret-token');
    expect(lines[1]).toContain('git-askpass.sh');
    expect(lines[2]).toBe('0');
    manager.close('sh-git');
  });

  it('captures stderr in the response and output file without persisting protocol markers', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-shell-'));
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    const manager = new ShellSessionManager(
      new PathSandbox(dir),
      RuntimeDataResolver.forTest(join(dir, 'runtime'), join(dir, 'users')),
    );
    const session = manager.getOrCreate(13, 'sh-stderr', 7, dir, {});
    const output = new OutputManager();

    session.writeStdin("printf 'validation failed\\n' >&2; false\necho __STDERR__ $?\n");
    const failed = await output.readUntilMarker(session, '__STDERR__', 5000);

    expect(failed.output).toBe('validation failed\n');
    expect(failed.exitCode).toBe(1);
    expect(readFileSync(session.outputFile, 'utf8')).toBe('validation failed\n');
    manager.close('sh-stderr');
  });

  it('captures the command exit code and keeps it out of the next read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-shell-'));
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    const manager = new ShellSessionManager(
      new PathSandbox(dir),
      RuntimeDataResolver.forTest(join(dir, 'runtime'), join(dir, 'users')),
    );
    const session = manager.getOrCreate(13, 'sh-exit', 7, dir, {});
    const output = new OutputManager();

    session.writeStdin('bash -c "exit 3"\necho __M1__ $?\n');
    const failed = await output.readUntilMarker(session, '__M1__', 5000);
    expect(failed.completed).toBe(true);
    expect(failed.exitCode).toBe(3);

    session.writeStdin('echo second\necho __M2__ $?\n');
    const ok = await output.readUntilMarker(session, '__M2__', 5000);
    expect(ok.exitCode).toBe(0);
    // 上一条命令回显的退出码不能残留到下一次读取
    expect(ok.output.trim()).toBe('second');
    manager.close('sh-exit');
  });

  it('kills the whole process group when a session closes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-shell-'));
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    const manager = new ShellSessionManager(
      new PathSandbox(dir),
      RuntimeDataResolver.forTest(join(dir, 'runtime'), join(dir, 'users')),
    );
    const session = manager.getOrCreate(14, 'sh-tree', 7, dir, {});
    const output = new OutputManager();

    session.writeStdin('sleep 300 & echo $!\necho __M__ $?\n');
    const started = await output.readUntilMarker(session, '__M__', 5000);
    const childPid = Number(started.output.trim().split('\n').pop());
    expect(childPid).toBeGreaterThan(0);
    expect(() => process.kill(childPid, 0)).not.toThrow();

    manager.close('sh-tree');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(() => process.kill(childPid, 0)).toThrow();
  });

  it('returns early on wait_for and keeps the rest of the output for the next read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-shell-'));
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    const manager = new ShellSessionManager(
      new PathSandbox(dir),
      RuntimeDataResolver.forTest(join(dir, 'runtime'), join(dir, 'users')),
    );
    const session = manager.getOrCreate(15, 'sh-wait', 7, dir, {});
    const output = new OutputManager();

    const marker = '__WAIT__';
    session.beginCommand(marker, true);
    session.writeStdin(`printf 'Listening on 3000\\n'; sleep 1; printf 'done\\n'\necho ${marker} $?\n`);
    const early = await output.readUntilMarker(session, marker, 5000, /Listening on/);
    expect(early.completed).toBe(false);
    expect(early.matched).toBe('Listening on');
    expect(early.output).toContain('Listening on 3000');
    expect(session.pendingCommand?.marker).toBe(marker);

    const rest = await output.readUntilMarker(session, marker, 5000, /Listening on/);
    expect(rest.completed).toBe(true);
    expect(rest.exitCode).toBe(0);
    expect(rest.output).toContain('done');
    // 已交付过的部分不再重复返回，wait_for 也不会被它二次命中
    expect(rest.output).not.toContain('Listening on');
    expect(session.pendingCommand).toBeNull();
    // 提前放行不影响落盘的完整性
    expect(readFileSync(session.outputFile, 'utf8')).toBe('Listening on 3000\ndone\n');
    manager.close('sh-wait');
  });

  it('keeps buffering output while nobody reads so a resumed read still sees it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-shell-'));
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    const manager = new ShellSessionManager(
      new PathSandbox(dir),
      RuntimeDataResolver.forTest(join(dir, 'runtime'), join(dir, 'users')),
    );
    const session = manager.getOrCreate(16, 'sh-buffer', 7, dir, {});
    const output = new OutputManager();

    const marker = '__RESUME__';
    session.beginCommand(marker, true);
    session.writeStdin(`printf 'first\\n'; sleep 0.4; printf 'second\\n'\necho ${marker} $?\n`);
    const timedOut = await output.readUntilMarker(session, marker, 100);
    expect(timedOut.completed).toBe(false);

    // 读取者已退出，这段时间的输出必须留在会话缓冲区里
    await new Promise((resolve) => setTimeout(resolve, 700));
    const resumed = await output.readUntilMarker(session, marker, 2000);
    expect(resumed.completed).toBe(true);
    expect(resumed.output).toContain('second');
    manager.close('sh-buffer');
  });

  it('does not re-register a consumed marker as a fake pending command', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-shell-'));
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    const manager = new ShellSessionManager(
      new PathSandbox(dir), RuntimeDataResolver.forTest(join(dir, 'runtime'), join(dir, 'users')),
    );
    const session = manager.getOrCreate(17, 'sh-consumed', 7, dir, {});
    const output = new OutputManager();

    const marker = '__CONSUMED__';
    session.beginCommand(marker, true);
    session.writeStdin(`echo done\necho ${marker} $?\n`);
    const first = await output.readUntilMarker(session, marker, 2000);
    expect(first.completed).toBe(true);
    expect(session.pendingCommand).toBeNull();

    // 模拟过期调用方拿着已消费的 marker 再来读：绝不能登记成永不结束的假命令把会话卡死
    const stale = await output.readUntilMarker(session, marker, 300);
    expect(stale.completed).toBe(true);
    expect(session.pendingCommand).toBeNull();

    // 会话必须仍然可用
    const nextMarker = '__NEXT__';
    session.beginCommand(nextMarker, true);
    session.writeStdin(`echo alive\necho ${nextMarker} $?\n`);
    const next = await output.readUntilMarker(session, nextMarker, 2000);
    expect(next.completed).toBe(true);
    expect(next.output).toContain('alive');
    manager.close('sh-consumed');
  });

  it('stops waiting as soon as the session is closed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-shell-'));
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    const manager = new ShellSessionManager(
      new PathSandbox(dir),
      RuntimeDataResolver.forTest(join(dir, 'runtime'), join(dir, 'users')),
    );
    const session = manager.getOrCreate(17, 'sh-abort', 7, dir, {});
    const output = new OutputManager();

    session.beginCommand('__NEVER__', true);
    session.writeStdin('sleep 30\necho __NEVER__ $?\n');
    const started = Date.now();
    const pending = output.readUntilMarker(session, '__NEVER__', 30_000);
    setTimeout(() => manager.close('sh-abort'), 100);
    const result = await pending;
    expect(result.completed).toBe(false);
    // 会话关闭要立刻唤醒读取者，而不是空等到 yield 超时
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('does not leak a marker that arrives split across two chunks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-shell-'));
    mkdirSync(join(dir, 'runtime'), { recursive: true });
    const manager = new ShellSessionManager(
      new PathSandbox(dir),
      RuntimeDataResolver.forTest(join(dir, 'runtime'), join(dir, 'users')),
    );
    const session = manager.getOrCreate(18, 'sh-split', 7, dir, {});
    const output = new OutputManager();

    session.beginCommand('__SPLIT__', true);
    session.process.stdout.emit('data', 'partial-output\n__SPL');
    const early = await output.readUntilMarker(session, '__SPLIT__', 50);
    expect(early.completed).toBe(false);
    expect(early.output).toBe('partial-output\n');

    session.process.stdout.emit('data', 'IT__ 5\n');
    const done = await output.readUntilMarker(session, '__SPLIT__', 50);
    expect(done.completed).toBe(true);
    expect(done.exitCode).toBe(5);
    expect(done.output).toBe('');
    expect(readFileSync(session.outputFile, 'utf8')).toBe('partial-output\n');
    manager.close('sh-split');
  });

  it('shellSessionManagerEnforcesLimitsAndCleanup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mao-shell-'));
    const manager = new ShellSessionManager(
      new PathSandbox(dir),
      RuntimeDataResolver.forTest(join(dir, 'runtime'), join(dir, 'users')),
      1,
    );
    const first = manager.getOrCreate(12, 'one', 7, dir, {});
    expect(() => manager.getOrCreate(12, 'two', 7, dir, {})).toThrow(/Maximum number of shell sessions/);
    first.close();
    manager.cleanupExpiredSessions();
    expect(manager.getActiveSessionCount()).toBe(0);
    manager.closeByConversation(12);
  });

  it('runs cleanupExpiredSessions on the scheduled interval', () => {
    vi.useFakeTimers();
    const dir = '/tmp/mao-shell-timer';
    const manager = new ShellSessionManager(
      new PathSandbox(dir),
      RuntimeDataResolver.forTest(join(dir, 'runtime'), join(dir, 'users')),
    );
    const spy = vi.spyOn(manager, 'cleanupExpiredSessions');
    manager.startCleanup(60_000);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(spy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(spy).toHaveBeenCalledTimes(2);
    manager.stopCleanup();
    vi.advanceTimersByTime(60_000);
    expect(spy).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
