import type { FastifyInstance } from 'fastify';
import { requireRequestPermission, sendOk } from '../common/http-error.js';
import { queryInt, queryOptInt, queryOptStr } from '../common/request.js';
import type { ApprovalRuleService } from './approval-rule.service.js';
import type { ApprovalRuleType } from './types.js';
import { APPROVAL_RULE_TYPES } from './types.js';

export function registerApprovalRuleAdminRoutes(
  app: FastifyInstance,
  deps: {
    approvalRuleService: ApprovalRuleService;
    permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
  },
): void {
  const { approvalRuleService, permissionService } = deps;

  // admin 只读清单：全用户规则（含用户名/会话标题 enrich、命中统计），支持 user/type/enabled 筛选
  app.get('/v1/admin/approval-rules', async (request, reply) => {
    await requireRequestPermission(permissionService, request, 'approval-rule:read');
    const page = queryInt(request, 'page', 1);
    const size = queryInt(request, 'size', 20);
    const typeRaw = queryOptStr(request, 'type');
    const ruleType: ApprovalRuleType | null = typeRaw != null && (APPROVAL_RULE_TYPES as readonly string[]).includes(typeRaw)
      ? typeRaw as ApprovalRuleType
      : null;
    const result = await approvalRuleService.adminPage({
      userId: queryOptInt(request, 'userId') ?? null,
      ruleType,
      enabled: parseEnabled(queryOptStr(request, 'enabled')),
      page,
      size,
    });
    return sendOk(reply, result);
  });
}

function parseEnabled(raw: string | undefined): boolean | null {
  if (raw === 'true' || raw === '1') return true;
  if (raw === 'false' || raw === '0') return false;
  return null;
}
