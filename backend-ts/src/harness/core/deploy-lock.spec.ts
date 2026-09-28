import { describe, expect, it } from 'vitest';
import {
  deployDrainSec,
  isDrainingInstance,
  isRecentDeployLock,
  isSessionActiveDuringDeploy,
  parseSqlDateTime,
  readDeployLock,
  shouldDeferAllRecoveryDuringDeploy,
} from './deploy-lock.js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { useTmpDir } from '../../testing/tmp-dir.js';

describe('deploy-lock', () => {
  it('parses SQL datetime', () => {
    const d = parseSqlDateTime('2026-08-16 15:30:00');
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
  });

  it('reads deploy lock json', () => {
    const dir = useTmpDir('mao-deploy-lock-');
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

  it('defaults drain seconds when lock omits drainSec', () => {
    expect(deployDrainSec(null)).toBe(60);
    expect(deployDrainSec({ startedAt: 1, oldPort: 9080, newPort: 9081, status: 'switched' })).toBe(60);
    expect(deployDrainSec({ startedAt: 1, oldPort: 9080, newPort: 9081, status: 'switched', drainSec: 120 })).toBe(120);
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

  describe('isDrainingInstance', () => {
    function setUp(status: string, oldPort: number, activePort?: number): string {
      const dir = useTmpDir('mao-draining-instance-');
      writeFileSync(join(dir, 'deploy.lock'), JSON.stringify({
        startedAt: Math.floor(Date.now() / 1000) - 5,
        oldPort,
        newPort: oldPort === 9080 ? 9081 : 9080,
        status,
        drainSec: 60,
      }));
      if (activePort != null) writeFileSync(join(dir, 'active-backend-port'), String(activePort));
      return dir;
    }

    it('is true only when traffic already moved off this port', () => {
      expect(isDrainingInstance(setUp('switched', 9080, 9081), 9080)).toBe(true);
      // 流量仍在本实例：说明该锁与本实例无关（或已回滚），不能按"待排空"处理。
      expect(isDrainingInstance(setUp('switched', 9080, 9080), 9080)).toBe(false);
      // 端口文件缺失时无法确认，保守返回 false（避免误退出/白等）。
      expect(isDrainingInstance(setUp('switched', 9080), 9080)).toBe(false);
      // 本实例是新端口。
      expect(isDrainingInstance(setUp('switched', 9080, 9081), 9081)).toBe(false);
      // 部署尚未切流。
      expect(isDrainingInstance(setUp('starting', 9080, 9081), 9080)).toBe(false);
      // 切流后进入已排空状态，同样成立。
      expect(isDrainingInstance(setUp('drained', 9080, 9081), 9080)).toBe(true);
      // 部署失败：流量没切走。
      expect(isDrainingInstance(setUp('failed', 9080, 9080), 9080)).toBe(false);
      expect(isDrainingInstance(setUp('switched', 9080, 9081), null)).toBe(false);
    });

    it('ignores stale lock', () => {
      const dir = useTmpDir('mao-draining-instance-stale-');
      writeFileSync(join(dir, 'deploy.lock'), JSON.stringify({
        startedAt: Math.floor(Date.now() / 1000) - 20 * 60,
        oldPort: 9080,
        newPort: 9081,
        status: 'switched',
        drainSec: 60,
      }));
      writeFileSync(join(dir, 'active-backend-port'), '9081');
      expect(isDrainingInstance(dir, 9080)).toBe(false);
    });
  });
});
