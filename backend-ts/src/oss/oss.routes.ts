import type { FastifyInstance } from 'fastify';
import { requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf } from '../common/request.js';
import type { OssStsService } from './oss-sts.service.js';

export interface OssRouteDeps {
  ossStsService: OssStsService;
}

export function registerOssRoutes(app: FastifyInstance, deps: OssRouteDeps): void {
  app.post('/v1/oss/sts-token', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ sessionId?: number | null }>(request);
    const token = await deps.ossStsService.generateStsToken(userId, body.sessionId);
    return sendOk(reply, token);
  });
}
