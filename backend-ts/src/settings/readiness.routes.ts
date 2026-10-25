import type { FastifyInstance } from 'fastify';
import type { OnboardingCompleteInput } from '@mao/contracts';
import { requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf } from '../common/request.js';
import type { ReadinessService } from './readiness.service.js';

export interface ReadinessRouteDeps {
  readinessService: ReadinessService;
  permissionService: { isAdmin(userId: number): Promise<boolean> };
}

export function registerReadinessRoutes(app: FastifyInstance, deps: ReadinessRouteDeps): void {
  app.get('/v1/readiness', async (request, reply) => {
    const userId = requireUserId(request);
    const isAdmin = await deps.permissionService.isAdmin(userId);
    return sendOk(reply, await deps.readinessService.getReadiness(userId, isAdmin));
  });

  app.put('/v1/readiness/onboarding', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<OnboardingCompleteInput>(request);
    const rawAgentId = typeof body.chosenAgentId === 'string' ? Number(body.chosenAgentId) : body.chosenAgentId;
    const chosenAgentId = typeof rawAgentId === 'number' && Number.isFinite(rawAgentId) && rawAgentId > 0
      ? rawAgentId
      : null;
    await deps.readinessService.completeOnboarding(userId, {
      chosenAgentId,
      skipped: body.skipped === true,
    });
    return sendOk(reply, { ok: true });
  });
}
