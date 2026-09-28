import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { useTmpDir } from '../../testing/tmp-dir.js';
import { DeployDrainWatcher } from './deploy-drain-watcher.js';

interface LockPatch {
  startedAt?: number;
  oldPort?: number;
  newPort?: number;
  status?: string;
  drainSec?: number;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

function writeLock(dir: string, patch: LockPatch = {}): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'deploy.lock'), JSON.stringify({
    startedAt: nowSec() - 5,
    oldPort: 9080,
    newPort: 9081,
    status: 'switched',
    drainSec: 60,
    ...patch,
  }));
}

function writeActivePort(dir: string, port: number): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'active-backend-port'), String(port));
}

function makeWatcher(
  dir: string,
  selfPort: number | null,
  options: { shutdown?: () => Promise<void>; startedAtSec?: number } = {},
) {
  const shutdown = vi.fn(options.shutdown ?? (async () => undefined));
  const exit = vi.fn();
  const watcher = new DeployDrainWatcher({
    runtimeDir: dir,
    selfPort,
    startedAtSec: options.startedAtSec ?? nowSec() - 60,
    shutdown,
    exit,
  });
  return { watcher, shutdown, exit };
}

describe('DeployDrainWatcher', () => {
  it('drainsAndExitsWhenTrafficSwitchedAwayFromThisInstance', async () => {
    const dir = useTmpDir('mao-drain-watcher-');
    writeLock(dir);
    // 切流后 active-backend-port 已指向新实例，本实例（9080）确认不再是承接方。
    writeActivePort(dir, 9081);
    const { watcher, shutdown, exit } = makeWatcher(dir, 9080);

    await watcher.poll();

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('ignoresLockWhenThisInstanceIsTheNewOne', async () => {
    const dir = useTmpDir('mao-drain-watcher-new-');
    writeLock(dir);
    writeActivePort(dir, 9081);
    const { watcher, shutdown, exit } = makeWatcher(dir, 9081);

    await watcher.poll();

    expect(shutdown).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('ignoresLockWhenThisPortIsStillTheActiveOne', async () => {
    const dir = useTmpDir('mao-drain-watcher-still-active-');
    // 端口在 9080/9081 间来回切：残留的 switched 锁其 oldPort 可能正好等于本实例端口，
    // 只要本实例仍是承接流量的那一个就不能自杀。
    writeLock(dir);
    writeActivePort(dir, 9080);
    const { watcher, shutdown, exit } = makeWatcher(dir, 9080);

    await watcher.poll();

    expect(shutdown).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('ignoresLockWhenActivePortFileIsMissing', async () => {
    const dir = useTmpDir('mao-drain-watcher-noport-file-');
    writeLock(dir);
    const { watcher, shutdown, exit } = makeWatcher(dir, 9080);

    await watcher.poll();

    expect(shutdown).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('ignoresLockStartedBeforeThisProcessBooted', async () => {
    const dir = useTmpDir('mao-drain-watcher-oldlock-');
    // 锁早于本进程启动：说明这是历史残留，本实例不是那次部署的旧实例。
    writeLock(dir, { startedAt: nowSec() - 120 });
    writeActivePort(dir, 9081);
    const { watcher, shutdown, exit } = makeWatcher(dir, 9080, { startedAtSec: nowSec() - 60 });

    await watcher.poll();

    expect(shutdown).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it.each(['starting', 'drained', 'failed'])('ignoresLockWithStatus=%s', async (status) => {
    const dir = useTmpDir('mao-drain-watcher-status-');
    writeLock(dir, { status });
    writeActivePort(dir, 9081);
    const { watcher, shutdown, exit } = makeWatcher(dir, 9080);

    await watcher.poll();

    expect(shutdown).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('ignoresStaleLock', async () => {
    const dir = useTmpDir('mao-drain-watcher-stale-');
    // 老于 DEPLOY_LOCK_MAX_AGE_SEC 的 lock 视为历史残留，不做任何动作（交给 SIGTERM 路径）。
    writeLock(dir, { startedAt: nowSec() - 20 * 60 });
    writeActivePort(dir, 9081);
    const { watcher, shutdown, exit } = makeWatcher(dir, 9080, { startedAtSec: nowSec() - 25 * 60 });

    await watcher.poll();

    expect(shutdown).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('ignoresMissingLock', async () => {
    const dir = useTmpDir('mao-drain-watcher-missing-');
    writeActivePort(dir, 9081);
    const { watcher, shutdown, exit } = makeWatcher(dir, 9080);

    await watcher.poll();

    expect(shutdown).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('treatsMissingSelfPortAsInactive', async () => {
    const dir = useTmpDir('mao-drain-watcher-noport-');
    writeLock(dir);
    writeActivePort(dir, 9081);
    const { watcher, shutdown, exit } = makeWatcher(dir, null);

    await watcher.poll();

    expect(shutdown).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it('handlesSameDeployOnceEvenIfPollingAgainBeforeExit', async () => {
    const dir = useTmpDir('mao-drain-watcher-once-');
    writeLock(dir);
    writeActivePort(dir, 9081);
    const { watcher, shutdown, exit } = makeWatcher(dir, 9080);

    await watcher.poll();
    await watcher.poll();

    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('stillExitsWhenGracefulDrainThrows', async () => {
    const dir = useTmpDir('mao-drain-watcher-throw-');
    writeLock(dir);
    writeActivePort(dir, 9081);
    const { watcher, exit } = makeWatcher(dir, 9080, {
      shutdown: async () => { throw new Error('drain boom'); },
    });

    await watcher.poll();

    expect(exit).toHaveBeenCalledWith(0);
  });

  it('startAndStopTogglePolling', async () => {
    vi.useFakeTimers();
    try {
      const dir = useTmpDir('mao-drain-watcher-timer-');
      writeLock(dir);
      writeActivePort(dir, 9081);
      const { watcher, shutdown } = makeWatcher(dir, 9080);

      watcher.start();
      await vi.advanceTimersByTimeAsync(DeployDrainWatcher.DEFAULT_POLL_INTERVAL_MS);
      expect(shutdown).toHaveBeenCalledTimes(1);

      watcher.stop();
      await vi.advanceTimersByTimeAsync(DeployDrainWatcher.DEFAULT_POLL_INTERVAL_MS * 3);
      expect(shutdown).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
