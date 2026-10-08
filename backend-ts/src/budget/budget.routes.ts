import type { FastifyInstance } from 'fastify';
import { requireRequestPermission, sendOk } from '../common/http-error.js';
import { bodyOf, pathId } from '../common/request.js';
import type { BudgetService } from './budget.service.js';

export interface BudgetRouteDeps {
  budgetService: BudgetService;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
}

interface BudgetUpsertRequest {
  scope?: string;
  scopeId?: number | null;
  limitType?: string;
  limitValue?: number;
  action?: string;
  enabled?: number | boolean;
}

export function registerBudgetRoutes(app: FastifyInstance, deps: BudgetRouteDeps): void {
  app.get('/v1/admin/budgets', async (request, reply) => {
    await requireRequestPermission(deps.permissionService, request, 'budget:read');
    return sendOk(reply, await deps.budgetService.list());
  });

  app.post('/v1/admin/budgets', async (request, reply) => {
    const userId = await requireRequestPermission(deps.permissionService, request, 'budget:write');
    const body = bodyOf<BudgetUpsertRequest>(request);
    const row = await deps.budgetService.create({
      scope: body.scope ?? '',
      scopeId: body.scopeId ?? null,
      limitType: body.limitType ?? '',
      limitValue: body.limitValue ?? 0,
      action: body.action ?? '',
      enabled: body.enabled,
      createdBy: userId,
    });
    return sendOk(reply, row);
  });

  app.put('/v1/admin/budgets/:id', async (request, reply) => {
    await requireRequestPermission(deps.permissionService, request, 'budget:write');
    const body = bodyOf<BudgetUpsertRequest>(request);
    const row = await deps.budgetService.update(pathId(request), {
      scope: body.scope ?? '',
      scopeId: body.scopeId ?? null,
      limitType: body.limitType ?? '',
      limitValue: body.limitValue ?? 0,
      action: body.action ?? '',
      enabled: body.enabled,
    });
    return sendOk(reply, row);
  });

  app.delete('/v1/admin/budgets/:id', async (request, reply) => {
    await requireRequestPermission(deps.permissionService, request, 'budget:write');
    await deps.budgetService.remove(pathId(request));
    return sendOk(reply);
  });
}
