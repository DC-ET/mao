import type { FastifyInstance } from 'fastify';
import { requireUserId } from '../common/auth.js';
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
}

export function registerAdminAnalyticsRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  app.get('/v1/admin/analytics/summary', async (req, reply) => {
    requireUserId(req, deps.jwt);
    const days = Number((req.query as { days?: string }).days ?? 30);
    sendJson(reply, 200, ok(await deps.analytics.summary(Math.max(1, Math.min(days, 90)))));
  });
}

export function registerAdminRuntimeRoutes(app: FastifyInstance, deps: AdminRouteDeps): void {
  app.get('/v1/admin/runtime/sessions', async (req, reply) => {
    requireUserId(req, deps.jwt);
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
