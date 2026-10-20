import type { FastifyInstance } from 'fastify';
import { requireRequestPermission, sendOk } from '../common/http-error.js';
import { queryInt, queryOptBool, queryOptStr } from '../common/request.js';
import type { UserToolCallStatRow } from '../admin/admin-analytics.service.js';
import type { AdminUserToolRepository, AdminUserToolRow } from './types.js';

/** 调用统计端口（AdminAnalyticsDbStore 满足；聚合 SQL 见 admin-analytics §9.4）。 */
export interface UserToolCallStatsPort {
  selectUserToolCallStats(slug?: string | null): Promise<UserToolCallStatRow[]>;
}

type PermissionChecker = { hasPermission(userId: number, code: string): Promise<boolean> };

export interface AdminUserToolRouteDeps {
  repo: AdminUserToolRepository;
  stats: UserToolCallStatsPort;
  permissionService: PermissionChecker;
}

/**
 * 管理侧自定义 HTTP 工具端点（技术方案 §5.9 / §5.10）：跨用户只读清单 + 调用统计。
 * 无任何写接口（管理员不可代操用户工具）；权限 user_tool:read。
 */
export function registerAdminUserToolRoutes(app: FastifyInstance, deps: AdminUserToolRouteDeps): void {
  const { repo, stats, permissionService } = deps;

  app.get('/v1/admin/user-tools', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'user_tool:read');
    const page = Math.max(1, queryInt(request, 'page', 1));
    const size = Math.min(100, Math.max(1, queryInt(request, 'size', 20)));
    const keyword = queryOptStr(request, 'keyword');
    const username = queryOptStr(request, 'username');
    const enabled = queryOptBool(request, 'enabled');
    const result = await repo.listForAdmin(page, size, { keyword, username, enabled });
    return sendOk(reply, {
      records: result.rows.map(toAdminVO),
      total: result.total,
      current: page,
      size,
    });
  });

  app.get('/v1/admin/user-tools/stats', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'user_tool:read');
    const slug = queryOptStr(request, 'slug');
    const rows = await stats.selectUserToolCallStats(slug);
    return sendOk(reply, rows.map((row) => ({
      slug: row.slug,
      calls: Number(row.calls ?? 0),
      errors: Number(row.errors ?? 0),
      failRate: Number(row.calls) > 0
        ? Math.round((Number(row.errors ?? 0) / Number(row.calls)) * 1000) / 1000
        : 0,
      users: Number(row.users ?? 0),
      firstAt: row.firstAt == null ? null : String(row.firstAt).replace(' ', 'T'),
      lastAt: row.lastAt == null ? null : String(row.lastAt).replace(' ', 'T'),
    })));
  });
}

/** 管理侧 VO：不含请求头（含密文风险，管理端一律不展示）；URL 明文（管理员排查需要）。 */
function toAdminVO(row: AdminUserToolRow) {
  return {
    id: row.id,
    userId: row.userId,
    username: row.username ?? null,
    name: row.name,
    displayName: row.displayName,
    description: row.description,
    method: row.method,
    url: row.url,
    readOnly: row.readOnly === 1,
    enabled: row.enabled === 1,
    timeoutMs: row.timeoutMs,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
  };
}
