import type { FastifyInstance } from 'fastify';
import { requireUserId } from '../../common/auth.js';
import { sendJson } from '../../common/http-error.js';
import { ok } from '../../common/result.js';
import type { JwtService } from '../../crypto/jwt.service.js';
import type { TaskNotificationPreferenceService } from './preference.service.js';

export interface TaskNotificationRouteDeps {
  jwt: JwtService;
  preference: TaskNotificationPreferenceService;
}

export function registerTaskNotificationPreferenceRoutes(app: FastifyInstance, deps: TaskNotificationRouteDeps): void {
  app.get('/v1/user-preferences/task-notification', async (req, reply) => {
    const userId = requireUserId(req, deps.jwt);
    sendJson(reply, 200, ok(await deps.preference.get(userId)));
  });

  app.put('/v1/user-preferences/task-notification', async (req, reply) => {
    const userId = requireUserId(req, deps.jwt);
    const body = (req.body ?? {}) as { enabled?: boolean; channel?: string; webhookUrl?: string };
    sendJson(reply, 200, ok(await deps.preference.save(userId, body.enabled === true, body.channel, body.webhookUrl)));
  });

  app.post('/v1/user-preferences/task-notification/test', async (req, reply) => {
    const userId = requireUserId(req, deps.jwt);
    const body = (req.body ?? {}) as { channel?: string; webhookUrl?: string };
    await deps.preference.sendTest(userId, body.channel ?? '', body.webhookUrl);
    sendJson(reply, 200, ok(null));
  });
}
