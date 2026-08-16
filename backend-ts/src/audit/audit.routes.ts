import type { FastifyInstance } from 'fastify';
import { sendOk } from '../common/http-error.js';
import { pathId, queryInt, queryOptBool, queryOptInt, queryOptStr } from '../common/request.js';
import type { AuditLogService } from './audit.service.js';

export interface AuditRouteDeps {
  auditLogService: AuditLogService;
}

export { registerAuditLogRoutes as registerAuditRoutes };

export function registerAuditLogRoutes(app: FastifyInstance, deps: AuditRouteDeps): void {
  const { auditLogService } = deps;

  app.get('/v1/audit/logs', async (request, reply) => {
    const page = queryInt(request, 'page', 1);
    const size = queryInt(request, 'size', 20);
    const startDate = queryOptStr(request, 'startDate');
    const endDate = queryOptStr(request, 'endDate');
    const result = await auditLogService.list(
      page,
      size,
      queryOptInt(request, 'userId'),
      queryOptStr(request, 'action'),
      queryOptStr(request, 'objectType'),
      queryOptBool(request, 'success'),
      startDate ? `${startDate} 00:00:00` : undefined,
      endDate ? `${endDate} 23:59:59` : undefined,
    );
    return sendOk(reply, {
      records: result.records,
      total: result.total,
      page: result.page,
      size: result.size,
    });
  });

  app.get('/v1/audit/logs/:id', async (request, reply) => {
    return sendOk(reply, await auditLogService.get(pathId(request)));
  });
}
