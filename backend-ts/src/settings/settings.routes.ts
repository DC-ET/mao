import type { FastifyInstance } from 'fastify';
import { sendOk } from '../common/http-error.js';
import { bodyOf, pathParam, queryOptStr } from '../common/request.js';
import type { SystemSettingService } from './settings.service.js';

export interface SystemSettingRouteDeps {
  systemSettingService: SystemSettingService;
}

interface UpdateSettingRequest {
  value?: string | null;
}

export { registerSystemSettingRoutes as registerSettingsRoutes };

export function registerSystemSettingRoutes(app: FastifyInstance, deps: SystemSettingRouteDeps): void {
  const { systemSettingService } = deps;

  app.get('/v1/system-settings', async (request, reply) => {
    return sendOk(reply, await systemSettingService.list(queryOptStr(request, 'category')));
  });

  app.put('/v1/system-settings/:key', async (request, reply) => {
    const body = bodyOf<UpdateSettingRequest>(request);
    return sendOk(reply, await systemSettingService.update(pathParam(request, 'key'), body.value));
  });
}
