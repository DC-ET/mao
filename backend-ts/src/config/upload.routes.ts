import type { FastifyInstance } from 'fastify';
import { sendOk } from '../common/http-error.js';
import type { UploadSettings } from '../settings/types.js';

export function registerUploadRoutes(app: FastifyInstance, getUploadConfig: () => Promise<UploadSettings>): void {
  app.get('/v1/upload/config', async (_request, reply) => {
    const { storageMode, baseUrl } = await getUploadConfig();
    return sendOk(reply, { storageMode, baseUrl });
  });
}
