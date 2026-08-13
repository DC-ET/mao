import type { FastifyInstance } from 'fastify';
import { sendOk } from '../common/http-error.js';

export function registerUploadRoutes(app: FastifyInstance, storageMode: string, baseUrl: string): void {
  app.get('/v1/upload/config', async (_request, reply) => {
    return sendOk(reply, { storageMode, baseUrl });
  });
}
