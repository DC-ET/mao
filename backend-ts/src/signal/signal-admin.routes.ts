import type { FastifyInstance } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requireRequestPermission, sendOk } from '../common/http-error.js';
import { pathId, queryInt, queryOptInt, queryOptStr } from '../common/request.js';
import type { PermissionService } from '../permission/permission.service.js';
import type { MysqlSignalWatcherRepository } from './signal.repository.js';
import { isSignalCompareMode, isSignalWatcherStatus } from './types.js';
import type { WatcherService } from './watcher.service.js';

/**
 * 信号哨兵管理后台只读接口（docs/plan/2026-10-11-signal-watcher-technical-design.md §5.9）：
 * 清单分页 + 筛选、单条配置详情、轮询记录，全部只读，`signal:read` 权限；
 * 详情与记录复用用户侧的脱敏口径（敏感请求头打码、body 只回长度）。
 */

export interface SignalAdminRouteDeps {
  watcherRepo: MysqlSignalWatcherRepository;
  /** 详情与轮询记录：复用用户侧脱敏口径，管理员跨用户只读。 */
  service: WatcherService;
  permissionService: PermissionService;
  /** 用户 ID → 展示名（装配层注入 userLookup）。 */
  userLookup: { findByIds(ids: number[]): Promise<Array<{ id?: number; username?: string | null; displayName?: string | null }>> };
}

function parsePage(request: Parameters<typeof queryInt>[0]): { page: number; size: number } {
  const size = queryInt(request, 'size', 20);
  return { page: queryInt(request, 'page', 1), size: Math.min(100, size) };
}

function parseId(raw: number): number {
  if (!Number.isInteger(raw) || raw <= 0) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '路径参数 id 必须为正整数');
  }
  return raw;
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
      lastValueSnippet: row.lastValueSnippet ?? null,
      lastChangeOldSnippet: row.lastChangeOldSnippet ?? null,
      lastChangeNewSnippet: row.lastChangeNewSnippet ?? null,
      consecutiveFailures: Number(row.consecutiveFailures ?? 0),
      createdAt: row.createdAt ?? null,
    }));
    return sendOk(reply, { records, total, page, size });
  });

  /** 单条配置详情（属主展示名一并返回，便于后台直接展示）。 */
  app.get('/v1/admin/signal-watchers/:id', async (request, reply) => {
    await requireRequestPermission(deps.permissionService, request, 'signal:read');
    const id = parseId(pathId(request));
    const view = await deps.service.getForAdmin(id);
    const [owner] = await deps.userLookup.findByIds([view.userId]);
    return sendOk(reply, {
      ...view,
      username: owner?.displayName ?? owner?.username ?? null,
    });
  });

  /** 轮询记录分页（字段与桌面端「轮询记录」一致）。 */
  app.get('/v1/admin/signal-watchers/:id/checks', async (request, reply) => {
    await requireRequestPermission(deps.permissionService, request, 'signal:read');
    const id = parseId(pathId(request));
    const { page, size } = parsePage(request);
    const { rows, total } = await deps.service.listChecksForAdmin(id, page, size);
    return sendOk(reply, { records: rows, total, page, size });
  });
}
