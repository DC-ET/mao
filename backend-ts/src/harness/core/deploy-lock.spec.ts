import { describe, expect, it } from 'vitest';
import {
  isRecentDeployLock,
  isSessionActiveDuringDeploy,
  parseSqlDateTime,
  readDeployLock,
  shouldDeferAllRecoveryDuringDeploy,
} from './deploy-lock.js';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('deploy-lock', () => {
  it('parses SQL datetime', () => {
    const d = parseSqlDateTime('2026-08-16 15:30:00');
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
  });

  it('reads deploy lock json', () => {
    const dir = join(tmpdir(), `mao-deploy-lock-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'deploy.lock'), JSON.stringify({
      startedAt: 1_700_000_000,
      oldPort: 9080,
      newPort: 9081,
      status: 'switched',
      drainSec: 300,
    }));
    const lock = readDeployLock(dir);
    expect(lock?.oldPort).toBe(9080);
    expect(lock?.newPort).toBe(9081);
    rmSync(dir, { recursive: true, force: true });
  });

  it('skips sessions active during deploy', () => {
    const startedAt = 1_700_000_000;
    const lock = { startedAt, oldPort: 9080, newPort: 9081, status: 'switched' };
    const activeAt = '2026-08-16 15:30:10';
    const deployAt = '2026-08-16 15:30:00';
    const lockFromSql = { ...lock, startedAt: Math.floor(parseSqlDateTime(deployAt)!.getTime() / 1000) };
    expect(isSessionActiveDuringDeploy({ lastActivityAt: activeAt }, lockFromSql)).toBe(true);
    const staleAt = '2026-08-16 15:28:00';
    expect(isSessionActiveDuringDeploy({ lastActivityAt: staleAt }, lockFromSql)).toBe(false);
  });

  it('detects recent deploy lock', () => {
    const now = 1_700_000_000;
    expect(isRecentDeployLock({ startedAt: now - 60, oldPort: 9080, newPort: 9081, status: 'switched' }, now)).toBe(true);
    expect(isRecentDeployLock({ startedAt: now - 3600, oldPort: 9080, newPort: 9081, status: 'drained' }, now)).toBe(false);
  });

  it('defers all recovery while deploy is in flight', () => {
    const now = 1_700_000_100;
    const lock = { startedAt: now - 30, oldPort: 9080, newPort: 9081, status: 'starting' };
    expect(shouldDeferAllRecoveryDuringDeploy(lock, now)).toBe(true);
    expect(shouldDeferAllRecoveryDuringDeploy({ ...lock, status: 'drained' }, now)).toBe(false);
  });
});
