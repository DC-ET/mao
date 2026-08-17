import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface DeployLock {
  startedAt: number;
  oldPort: number;
  newPort: number;
  status: string;
  drainSec?: number;
}

export const DEPLOY_LOCK_MAX_AGE_SEC = 15 * 60;
export const DEPLOY_ACTIVITY_BUFFER_SEC = 60;

export function deployLockPath(runtimeDir: string): string {
  return join(runtimeDir, 'deploy.lock');
}

export function readDeployLock(runtimeDir: string): DeployLock | null {
  const path = deployLockPath(runtimeDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DeployLock>;
    if (typeof parsed.startedAt !== 'number') return null;
    return {
      startedAt: parsed.startedAt,
      oldPort: Number(parsed.oldPort ?? 0),
      newPort: Number(parsed.newPort ?? 0),
      status: String(parsed.status ?? ''),
      drainSec: parsed.drainSec != null ? Number(parsed.drainSec) : undefined,
    };
  } catch {
    return null;
  }
}

export function isRecentDeployLock(lock: DeployLock | null, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (lock == null) return false;
  return nowSec - lock.startedAt <= DEPLOY_LOCK_MAX_AGE_SEC;
}

export function parseSqlDateTime(value: string | null | undefined): Date | null {
  if (value == null || value.trim() === '') return null;
  const normalized = value.trim().replace(' ', 'T');
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Sessions active around deploy start are assumed to still run on the draining old instance. */
export function isSessionActiveDuringDeploy(
  session: { lastActivityAt?: string | null },
  lock: DeployLock,
): boolean {
  const lastActivity = parseSqlDateTime(session.lastActivityAt);
  if (lastActivity == null) return false;
  const deployStartMs = lock.startedAt * 1000 - DEPLOY_ACTIVITY_BUFFER_SEC * 1000;
  return lastActivity.getTime() >= deployStartMs;
}

export function deployDrainSec(lock: DeployLock | null): number {
  if (lock?.drainSec != null && lock.drainSec > 0) return lock.drainSec;
  return 60;
}

const IN_FLIGHT_DEPLOY_STATUSES = new Set(['starting', 'switched']);

/** During blue-green deploy, new instances must not recover any RUNNING sessions. */
export function shouldDeferAllRecoveryDuringDeploy(lock: DeployLock | null, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (lock == null || !isRecentDeployLock(lock, nowSec)) return false;
  return IN_FLIGHT_DEPLOY_STATUSES.has(lock.status);
}
