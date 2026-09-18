import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../common/http-error.js';
import { sendJson } from '../common/http-error.js';
import { ok } from '../common/result.js';
import type { JwtService } from '../crypto/jwt.service.js';
import type { AdminAnalyticsService } from './admin-analytics.service.js';

export interface AdminSessionLister {
  listSessionsForAdmin(
    page: number,
    size: number,
    userId?: number,
    agentId?: number,
    executionMode?: string,
    phase?: string,
    keyword?: string,
    status?: string,
  ): Promise<{ records: unknown[]; total: number; current: number; size: number }>;
}

export interface AdminRouteDeps {
  jwt: JwtService;
  analytics: AdminAnalyticsService;
  sessionLister?: AdminSessionLister;
  permissionService: { isAdmin(userId: number | null | undefined): Promise<boolean> };
}

interface AnalyticsQueryRaw {
  days?: string;
  endOffset?: string;
  limit?: string;
}

function parseAnalyticsQuery(raw: AnalyticsQueryRaw): { days: number; endOffset: number; limit: number } {
  const days = Number(raw.days ?? 30);
  const endOffset = Number(raw.endOffset ?? 0);
  const limit = Number(raw.limit ?? 20);
  return {
    days: Math.max(1, Math.min(Number.isFinite(days) ? days : 30, 90)),
    endOffset: Math.max(0, Math.min(Number.isFinite(endOffset) ? endOffset : 0, 365)),
    limit: Math.max(1, Math.min(Number.isFinite(limit) ? limit : 20, 100)),
  };
}

export function registerAdminAnalyticsRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  // 旧巨型汇总：管理后台已切换 scope 接口，暂留给 mao-cli / 兼容调用方。
  app.get('/v1/admin/analytics/summary', async (req, reply) => {
    await requireAdmin(deps.permissionService, req);
    const { days, endOffset } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.summary(days, endOffset)));
  });

  app.get('/v1/admin/analytics/overview', async (req, reply) => {
    await requireAdmin(deps.permissionService, req);
    const { days, endOffset } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.overview(days, endOffset)));
  });

  app.get('/v1/admin/analytics/trends', async (req, reply) => {
    await requireAdmin(deps.permissionService, req);
    const { days, endOffset } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.trendsScope(days, endOffset)));
  });

  app.get('/v1/admin/analytics/models', async (req, reply) => {
    await requireAdmin(deps.permissionService, req);
    const { days, endOffset } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.modelsScope(days, endOffset)));
  });

  app.get('/v1/admin/analytics/users', async (req, reply) => {
    await requireAdmin(deps.permissionService, req);
    const { days, endOffset, limit } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.usersScope(days, endOffset, limit)));
  });

  app.get('/v1/admin/analytics/agents', async (req, reply) => {
    await requireAdmin(deps.permissionService, req);
    const { days, endOffset, limit } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.agentsScope(days, endOffset, limit)));
  });

  app.get('/v1/admin/analytics/sessions', async (req, reply) => {
    await requireAdmin(deps.permissionService, req);
    const { days, endOffset } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.sessionsScope(days, endOffset)));
  });
}

export function registerAdminRuntimeRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  app.get('/v1/admin/runtime/sessions', async (req, reply) => {
    await requireAdmin(deps.permissionService, req);
    const q = req.query as {
      page?: string;
      size?: string;
      userId?: string;
      agentId?: string;
      executionMode?: string;
      phase?: string;
      keyword?: string;
      status?: string;
    };
    const page = Number(q.page ?? 1);
    const size = Number(q.size ?? 20);
    const runtimePhase = !q.phase || q.phase.trim() === ''
      ? 'RUNNING,RESUMING,WAITING_APPROVAL,FAILED,CANCELLED'
      : q.phase;
    if (!deps.sessionLister) {
      sendJson(reply, 200, ok({ records: [], total: 0, page, size }));
      return;
    }
    const result = await deps.sessionLister.listSessionsForAdmin(
      page,
      size,
      q.userId != null ? Number(q.userId) : undefined,
      q.agentId != null ? Number(q.agentId) : undefined,
      q.executionMode,
      runtimePhase,
      q.keyword,
      q.status,
    );
    sendJson(reply, 200, ok(result));
  });

}
