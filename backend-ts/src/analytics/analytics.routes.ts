import type { FastifyInstance } from 'fastify';
import { requireRequestPermission, sendJson } from '../common/http-error.js';
import { ok } from '../common/result.js';
import type { JwtService } from '../crypto/jwt.service.js';
import type { AnalyticsService } from './analytics.service.js';

export interface AnalyticsRouteDeps {
  jwt: JwtService;
  analytics: AnalyticsService;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
}

export function registerAnalyticsRoutes(app: FastifyInstance, deps: AnalyticsRouteDeps): void {
  app.get('/v1/analytics/trends', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const days = Number((req.query as { days?: string }).days ?? 7);
    sendJson(reply, 200, ok(await deps.analytics.getUsageTrends(Number.isFinite(days) ? days : 7)));
  });

  app.get('/v1/analytics/tokens', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    sendJson(reply, 200, ok(await deps.analytics.getTokenAnalysis()));
  });

  app.get('/v1/analytics/users', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    sendJson(reply, 200, ok(await deps.analytics.getUserActivity()));
  });

  app.get('/v1/analytics/agents/:id', async (req, reply) => {
    await requireRequestPermission(deps.permissionService, req, 'analytics:read');
    const id = Number((req.params as { id: string }).id);
    sendJson(reply, 200, ok(await deps.analytics.getAgentEfficiency(id)));
  });
}
