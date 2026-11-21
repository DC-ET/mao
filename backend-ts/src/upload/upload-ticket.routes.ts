import type { FastifyInstance } from 'fastify';

import { requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf } from '../common/request.js';
import type { UploadTicketService } from './upload-ticket.service.js';

export interface UploadTicketRouteDeps {
  uploadTicketService: UploadTicketService;
}

/** 预签名直传票据签发：替代旧 POST /v1/oss/sts-token（STS 链路已废弃）。 */
export function registerUploadTicketRoutes(app: FastifyInstance, deps: UploadTicketRouteDeps): void {
  app.post('/v1/upload/ticket', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ contentType?: string; fileName?: string }>(request);
    const ticket = await deps.uploadTicketService.generateTicket(userId, body.contentType, body.fileName);
    return sendOk(reply, ticket);
  });
}
