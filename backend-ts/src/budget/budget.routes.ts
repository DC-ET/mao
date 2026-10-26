import type { FastifyInstance } from 'fastify';
import { requireRequestPermission, requireUserId, sendOk } from '../common/http-error.js';
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
  // 对本人生效的用量预算（GLOBAL + 本人 USER scope）。仅需登录，不加权限码（决策 1/2）。
  app.get('/v1/me/budgets', async (request, reply) => {
    const userId = requireUserId(request);
    return sendOk(reply, await deps.budgetService.myBudgets(userId));
  });

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
