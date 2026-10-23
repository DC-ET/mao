import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { registerAppHooks } from '../app-hooks.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { JwtService } from '../crypto/jwt.service.js';
import type { ApiTokenService } from '../openapi/api-token.service.js';
import type { AuditLogService } from '../audit/audit.service.js';
import type { AuditLog } from './types.js';
import type { MysqlUserRepository } from '../user/user.repository.js';

/**
 * BUGCHECK（审查新增，非产品代码）：业务失败被审计日志记成「成功」，失败原因恒为空。
 *
 * 根因：本仓库的 REST 约定是「业务错误也返回 HTTP 200，错误放在响应体 code 上」
 * （`common/http-error.ts` 的 `handleError`：只有 1001/1002 映射成 401/403，
 * 其余 BusinessException 一律 `sendJson(reply, 200, fail(code, message))`）。
 * 而全局审计钩子（`app-hooks.ts` 的 onResponse → `audit/audit.interceptor.ts`
 * 的 `recordAudit`）判定成功与否只看 HTTP 状态码与 errorMessage：
 *
 * ```ts
 * success: input.errorMessage == null && input.status < 400,   // ← status 恒为 200
 * errorMessage: input.errorMessage != null ? truncate(...) : null,  // ← 钩子从不传 errorMessage
 * ```
 *
 * 后果：`DELETE /v1/agents/999` 这类失败操作（AGENT_NOT_FOUND=3001，HTTP 200）
 * 在审计日志里落成 status=200 / success=1 / error_message=NULL —— 管理后台
 * 「审计日志」详情里的「错误」永远显示 '-'，且失败操作被统计成成功。
 *
 * 断言按「本应如此」书写：失败的业务操作必须记 success=0 并带上失败原因。
 * 当前源码下断言失败即证明 BUG 真实存在。
 */

function buildApp(records: AuditLog[]) {
  const app = Fastify();

  const jwt = {
    validateAccessToken: () => true,
    getUserIdFromToken: () => 42,
    getTokenType: () => 'access',
  } as unknown as JwtService;

  const apiTokenService = {
    resolveByToken: vi.fn(async () => ({ ok: false, reason: 'not_found' })),
  } as unknown as ApiTokenService;

  const auditService = {
    record: vi.fn(async (log: AuditLog) => {
      records.push(log);
    }),
  } as unknown as AuditLogService;

  const userRepo = {
    findById: vi.fn(async () => ({ id: 42, username: 'admin', status: 1, deleted: 0 })),
  } as unknown as MysqlUserRepository;

  registerAppHooks({
    app,
    jwt,
    apiTokenService,
    openCallLogHolder: { current: null },
    auditService,
    userRepo,
    ssoExchangePath: '/api/v1/auth/sso/exchange',
  });

  // 受审计前缀（'/v1/agents'）下的写操作：业务失败（Agent 不存在）
  app.delete('/v1/agents/:id', async () => {
    throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
  });

  return app;
}

describe('BUGCHECK audit log must record business failures as failures', () => {
  it('marks a business-error response (HTTP 200 + error code) as failed and keeps the reason', async () => {
    const records: AuditLog[] = [];
    const app = buildApp(records);

    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/agents/999',
      headers: { authorization: 'Bearer any-token' },
    });

    // 业务错误的 HTTP 状态确实是 200（错误在响应体 code 上）
    expect(res.statusCode).toBe(200);
    expect((res.json() as { code: number }).code).toBe(ErrorCode.AGENT_NOT_FOUND.code);

    // 审计记录是 fire-and-forget，等一拍让它落库
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(records).toHaveLength(1);
    const log = records[0]!;
    // 失败操作不得记成成功
    expect(log.success).toBe(0);
    // 失败原因必须落库（管理后台详情页会展示这一列）
    expect(log.errorMessage ?? '').not.toBe('');
  });
});
