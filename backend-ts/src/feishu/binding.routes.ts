import type { FastifyInstance } from 'fastify';
import { requireUserId } from '../common/auth.js';
import { sendJson } from '../common/http-error.js';
import { ok } from '../common/result.js';
import type { JwtService } from '../crypto/jwt.service.js';
import type { FeishuBindingRepository } from './binding.repository.js';
import type { FeishuAuthService } from '../auth/feishu-auth.service.js';

export interface FeishuBindingRouteDeps { jwt: JwtService; repository: FeishuBindingRepository; auth?: FeishuAuthService; }
export function registerFeishuBindingRoutes(app: FastifyInstance, deps: FeishuBindingRouteDeps): void {
  app.get('/v1/feishu/binding/status', async (request, reply) => sendJson(reply, 200, ok(await deps.repository.getStatus(requireUserId(request, deps.jwt)))));
  app.post('/v1/feishu/binding', async (request, reply) => {
    const userId = requireUserId(request, deps.jwt);
    if (deps.auth == null) return sendJson(reply, 200, ok({ authUrl: '' }));
    const link = await deps.auth.getQrCodeUrl(userId);
    return sendJson(reply, 200, ok(link));
  });
  app.delete('/v1/feishu/binding', async (request, reply) => {
    const userId = requireUserId(request, deps.jwt);
    await deps.repository.unbind(userId);
    return sendJson(reply, 200, ok(null));
  });
}
