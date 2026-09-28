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

export function activePortPath(runtimeDir: string): string {
  return join(runtimeDir, 'active-backend-port');
}

/**
 * 当前承接 nginx 流量的后端端口（蓝绿切换后由发布脚本写入）。
 * 读取失败/文件缺失返回 null——此时任何"仅 active 实例可做"的后台动作都应跳过。
 */
export function readActiveBackendPort(runtimeDir: string): number | null {
  const path = activePortPath(runtimeDir);
  if (!existsSync(path)) return null;
  try {
    const port = Number(readFileSync(path, 'utf8').trim());
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
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

/**
 * 该部署锁是否表示"本次部署已经把本实例替换掉"：切流已完成（`switched`/`drained`）、
 * 被替换的正是本端口、且 `active-backend-port` 已不再指向本实例。
 *
 * 三个条件缺一不可：端口在 9080/9081 之间来回切，历史残留的 `switched` 锁其 `oldPort`
 * 可能正好等于本实例端口；只看端口会让正常实例误判为"待排空的旧实例"而自杀/白等。
 */
export function isDrainingInstance(runtimeDir: string, selfPort: number | null): boolean {
  if (selfPort == null) return false;
  const lock = readDeployLock(runtimeDir);
  if (lock == null || !isRecentDeployLock(lock)) return false;
  if (lock.status !== 'switched' && lock.status !== 'drained') return false;
  if (lock.oldPort !== selfPort) return false;
  const active = readActiveBackendPort(runtimeDir);
  return active != null && active !== selfPort;
}

const IN_FLIGHT_DEPLOY_STATUSES = new Set(['starting', 'switched']);

/** During blue-green deploy, new instances must not recover any RUNNING sessions. */
export function shouldDeferAllRecoveryDuringDeploy(lock: DeployLock | null, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (lock == null || !isRecentDeployLock(lock, nowSec)) return false;
  return IN_FLIGHT_DEPLOY_STATUSES.has(lock.status);
}
