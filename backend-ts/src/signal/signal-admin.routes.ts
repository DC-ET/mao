import type { FastifyInstance } from 'fastify';
import { sendOk } from '../common/http-error.js';
import { queryInt, queryOptInt, queryOptStr } from '../common/request.js';
import { requireRequestPermission } from '../common/http-error.js';
import type { PermissionService } from '../permission/permission.service.js';
import type { MysqlSignalWatcherRepository } from './signal.repository.js';
import { isSignalCompareMode, isSignalWatcherStatus } from './types.js';

/**
 * 信号哨兵管理后台只读清单（docs/plan/2026-10-11-signal-watcher-technical-design.md §5.9）。
 * 只做清单分页 + 筛选，不做统计图表；`signal:read` 权限。
 */

export interface SignalAdminRouteDeps {
  watcherRepo: MysqlSignalWatcherRepository;
  permissionService: PermissionService;
  /** 用户 ID → 展示名（装配层注入 userLookup）。 */
  userLookup: { findByIds(ids: number[]): Promise<Array<{ id?: number; username?: string | null; displayName?: string | null }>> };
}

function parsePage(request: Parameters<typeof queryInt>[0]): { page: number; size: number } {
  const size = queryInt(request, 'size', 20);
  return { page: queryInt(request, 'page', 1), size: Math.min(100, size) };
}

export function registerSignalAdminRoutes(app: FastifyInstance, deps: SignalAdminRouteDeps): void {
  app.get('/v1/admin/signal-watchers', async (request, reply) => {
    await requireRequestPermission(deps.permissionService, request, 'signal:read');
    const { page, size } = parsePage(request);
    const statusRaw = queryOptStr(request, 'status');
    const status = statusRaw != null && isSignalWatcherStatus(statusRaw) ? statusRaw : null;
    const userId = queryOptInt(request, 'userId');
    const compareModeRaw = queryOptStr(request, 'compareMode');
    const compareMode = compareModeRaw != null && isSignalCompareMode(compareModeRaw) ? compareModeRaw : null;
    const { rows, total } = await deps.watcherRepo.listForAdmin(page, size, { status, userId, compareMode });
    const nameMap = new Map<number, string>();
    if (rows.length > 0) {
      const users = await deps.userLookup.findByIds([...new Set(rows.map((r) => r.userId))]);
      for (const user of users) {
        if (user.id != null) {
          nameMap.set(Number(user.id), user.displayName ?? user.username ?? `#${user.id}`);
        }
      }
    }
    const records = rows.map((row) => ({
      id: row.id,
      name: row.name,
      userId: row.userId,
      username: nameMap.get(row.userId) ?? null,
      url: row.url,
      method: row.method,
      intervalMinutes: row.intervalMinutes,
      compareMode: row.compareMode,
      triggerMode: row.triggerMode,
      status: row.status,
      lastCheckedAt: row.lastCheckedAt,
      lastChangedAt: row.lastChangedAt,
      consecutiveFailures: Number(row.consecutiveFailures ?? 0),
      createdAt: row.createdAt ?? null,
    }));
    return sendOk(reply, { records, total, page, size });
  });
}
