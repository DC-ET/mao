import { mkdirSync } from 'node:fs';
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
