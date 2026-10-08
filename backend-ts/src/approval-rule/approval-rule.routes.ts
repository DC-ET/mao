import type { FastifyInstance, FastifyRequest } from 'fastify';
import { requireUserId, sendOk } from '../common/http-error.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { bodyOf, queryOptBool, queryOptInt, queryOptStr } from '../common/request.js';
import type { ApprovalRuleService } from './approval-rule.service.js';
import type { ApprovalRuleScope, ApprovalRuleType } from './types.js';
import { APPROVAL_RULE_SCOPES, APPROVAL_RULE_TYPES } from './types.js';

interface CreateApprovalRuleRequest {
  ruleType?: string;
  ruleValue?: string;
}

interface UpdateApprovalRuleRequest {
  enabled?: boolean;
  ruleValue?: string;
}

/** 审计输入（由 create-app 装配，路由层只给事实）。 */
export interface ApprovalRuleAuditInput {
  request: FastifyRequest;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  objectId: number;
  detail: string;
}

export function registerApprovalRuleRoutes(
  app: FastifyInstance,
  deps: {
    approvalRuleService: ApprovalRuleService;
    audit?: (input: ApprovalRuleAuditInput) => void;
  },
): void {
  const { approvalRuleService, audit } = deps;

  const auditAnd = (request: FastifyRequest, action: 'CREATE' | 'UPDATE' | 'DELETE', objectId: number, detail: string) => {
    audit?.({ request, action, objectId, detail });
  };

  // 规则清单（登录用户，本人数据；默认仅 USER 级，includeSession=1&sessionId=x 附带该会话 SESSION 规则）
  app.get('/v1/approval-rules', async (request, reply) => {
    const userId = requireUserId(request);
    const query = request.query as Record<string, unknown>;
    const scopeRaw = queryOptStr(request, 'scope') ?? 'USER';
    const scope: ApprovalRuleScope | null = (APPROVAL_RULE_SCOPES as readonly string[]).includes(scopeRaw) ? scopeRaw as ApprovalRuleScope : 'USER';
    const includeSession = queryOptBool(request, 'includeSession') === true;
    const sessionId = queryOptInt(request, 'sessionId') ?? null;
    // 类型筛选：与 scope 一样只认白名单值，越界值视为不过滤（设置页类型 tab 走此参数，服务端分页口径才能与 tab 一致）
    const ruleTypeRaw = queryOptStr(request, 'ruleType');
    const ruleType: ApprovalRuleType | null = ruleTypeRaw != null && (APPROVAL_RULE_TYPES as readonly string[]).includes(ruleTypeRaw) ? ruleTypeRaw as ApprovalRuleType : null;
    const result = await approvalRuleService.listUserRules(userId, {
      scope,
      ruleType,
      includeSession,
      sessionId,
      page: queryOptInt(request, 'page') ?? 1,
      pageSize: queryOptInt(request, 'pageSize') ?? 20,
    });
    return sendOk(reply, result);
  });

  // 手动创建用户级规则（服务端归一化 + denylist 拒绝；响应返回归一化后的 ruleValue）
  app.post('/v1/approval-rules', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<CreateApprovalRuleRequest>(request);
    const vo = await approvalRuleService.createUserRule(userId, {
      ruleType: String(body.ruleType ?? ''),
      ruleValue: String(body.ruleValue ?? ''),
    });
    auditAnd(request, 'CREATE', vo.id, `ruleType=${vo.ruleType}, ruleValue=${vo.ruleValue}`);
    return sendOk(reply, vo);
  });

  // 启停 / 编辑值（重过归一化与 denylist）
  app.patch('/v1/approval-rules/:id', async (request, reply) => {
    const userId = requireUserId(request);
    const id = requirePathId(request);
    const body = bodyOf<UpdateApprovalRuleRequest>(request);
    const vo = await approvalRuleService.updateUserRule(userId, id, {
      enabled: typeof body.enabled === 'boolean' ? body.enabled : null,
      ruleValue: typeof body.ruleValue === 'string' ? body.ruleValue : null,
    });
    auditAnd(request, 'UPDATE', id, `ruleType=${vo.ruleType}, ruleValue=${vo.ruleValue}, enabled=${vo.enabled}`);
    return sendOk(reply, vo);
  });

  app.delete('/v1/approval-rules/:id', async (request, reply) => {
    const userId = requireUserId(request);
    const id = requirePathId(request);
    await approvalRuleService.removeUserRule(userId, id);
    auditAnd(request, 'DELETE', id, '');
    return sendOk(reply);
  });
}

function requirePathId(request: FastifyRequest): number {
  const raw = (request.params as { id?: string }).id;
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new BusinessException(ErrorCode.APPROVAL_RULE_NOT_FOUND);
  }
  return id;
}
