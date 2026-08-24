import type { FastifyInstance } from 'fastify';
import { requireAdmin, sendJson } from '../common/http-error.js';
import { ok } from '../common/result.js';
import type { JwtService } from '../crypto/jwt.service.js';
import type { StatisticsService } from './statistics.service.js';

export interface StatisticsRouteDeps {
  jwt: JwtService;
  statistics: StatisticsService;
  permissionService: { isAdmin(userId: number | null | undefined): Promise<boolean> };
}

export function registerStatisticsRoutes(app: FastifyInstance, deps: StatisticsRouteDeps): void {
  app.get('/v1/statistics/overview', async (req, reply) => {
    await requireAdmin(deps.permissionService, req);
    sendJson(reply, 200, ok(await deps.statistics.getOverview()));
  });

  app.get('/v1/statistics/agents', async (req, reply) => {
    await requireAdmin(deps.permissionService, req);
    sendJson(reply, 200, ok(await deps.statistics.getAgentStats()));
  });

  app.get('/v1/statistics/models', async (req, reply) => {
    await requireAdmin(deps.permissionService, req);
    sendJson(reply, 200, ok(await deps.statistics.getModelStats()));
  });

  app.get('/v1/statistics/users', async (req, reply) => {
    await requireAdmin(deps.permissionService, req);
    sendJson(reply, 200, ok(await deps.statistics.getUserStats()));
  });
}
