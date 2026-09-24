import type { FastifyInstance } from 'fastify';
import { requireRequestPermission } from '../common/http-error.js';
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
  ): Promise<{ records: unknown[]; total: number; current: number; size: number; matchSnippets?: Record<number, string> }>;
}

export interface AdminRouteDeps {
  jwt: JwtService;
  analytics: AdminAnalyticsService;
  sessionLister?: AdminSessionLister;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
}

interface AnalyticsQueryRaw {
  days?: string;
  endOffset?: string;
  limit?: string;
  excludeConnectivity?: string;
  modelId?: string;
}

function parseAnalyticsQuery(raw: AnalyticsQueryRaw): {
  days: number;
  endOffset: number;
  limit: number;
  excludeConnectivity: boolean;
  modelId: number | null;
} {
  const days = Number(raw.days ?? 30);
  const endOffset = Number(raw.endOffset ?? 0);
  const limit = Number(raw.limit ?? 20);
  const modelIdRaw = raw.modelId == null || raw.modelId === '' ? null : Number(raw.modelId);
  return {
    days: Math.max(1, Math.min(Number.isFinite(days) ? days : 30, 90)),
    endOffset: Math.max(0, Math.min(Number.isFinite(endOffset) ? endOffset : 0, 365)),
    limit: Math.max(1, Math.min(Number.isFinite(limit) ? limit : 20, 100)),
    // 默认排除连通性测试，避免模型配置自检污染质量指标
    excludeConnectivity: raw.excludeConnectivity !== 'false' && raw.excludeConnectivity !== '0',
    modelId: modelIdRaw != null && Number.isFinite(modelIdRaw) ? modelIdRaw : null,
  };
}

export function registerAdminAnalyticsRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  // 旧巨型汇总：管理后台已切换 scope 接口，暂留给 mao-cli / 兼容调用方。
  app.get('/v1/admin/analytics/summary', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.summary(days, endOffset)));
  });

  app.get('/v1/admin/analytics/overview', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.overview(days, endOffset)));
  });

  app.get('/v1/admin/analytics/trends', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset, excludeConnectivity } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    const granularity = (req.query as { granularity?: string }).granularity === 'hour' ? 'hour' : 'day';
    sendJson(reply, 200, ok(await deps.analytics.trendsScope(days, endOffset, { excludeConnectivity, granularity })));
  });

  app.get('/v1/admin/analytics/models', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset, excludeConnectivity, modelId } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(
      reply,
      200,
      ok(await deps.analytics.modelsScope(days, endOffset, { excludeConnectivity, sceneModelId: modelId })),
    );
  });

  app.get('/v1/admin/analytics/users', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset, limit, excludeConnectivity } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.usersScope(days, endOffset, limit, { excludeConnectivity })));
  });

  app.get('/v1/admin/analytics/agents', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset, limit, excludeConnectivity } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.agentsScope(days, endOffset, limit, { excludeConnectivity })));
  });

  app.get('/v1/admin/analytics/sessions', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const { days, endOffset, excludeConnectivity } = parseAnalyticsQuery(req.query as AnalyticsQueryRaw);
    sendJson(reply, 200, ok(await deps.analytics.sessionsScope(days, endOffset, { excludeConnectivity })));
  });
}

export function registerAdminRuntimeRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  app.get('/v1/admin/runtime/sessions', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'session:read');
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
