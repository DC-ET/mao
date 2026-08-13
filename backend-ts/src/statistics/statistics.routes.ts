import type { FastifyInstance } from 'fastify';
import { requireUserId } from '../common/auth.js';
import { sendJson } from '../common/http-error.js';
import { ok } from '../common/result.js';
import type { JwtService } from '../crypto/jwt.service.js';
import type { StatisticsService } from './statistics.service.js';

export interface StatisticsRouteDeps {
  jwt: JwtService;
  statistics: StatisticsService;
}

export function registerStatisticsRoutes(app: FastifyInstance, deps: StatisticsRouteDeps): void {
  app.get('/v1/statistics/overview', async (req, reply) => {
    requireUserId(req, deps.jwt);
    sendJson(reply, 200, ok(await deps.statistics.getOverview()));
  });

  app.get('/v1/statistics/agents', async (req, reply) => {
    requireUserId(req, deps.jwt);
    sendJson(reply, 200, ok(await deps.statistics.getAgentStats()));
  });

  app.get('/v1/statistics/models', async (req, reply) => {
    requireUserId(req, deps.jwt);
    sendJson(reply, 200, ok(await deps.statistics.getModelStats()));
  });

  app.get('/v1/statistics/users', async (req, reply) => {
    requireUserId(req, deps.jwt);
    sendJson(reply, 200, ok(await deps.statistics.getUserStats()));
  });
}
