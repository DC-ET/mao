import type { FastifyReply, FastifyRequest } from 'fastify';
import { BusinessException } from './business-exception.js';
import { ErrorCode } from './error-code.js';
import { fail, failCode, ok } from './result.js';
import { toJacksonJson } from './json.js';

export type AuthedRequest = FastifyRequest & { userId?: number };

export function sendJson(reply: FastifyReply, status: number, body: unknown): FastifyReply {
  return reply.status(status).header('Content-Type', 'application/json; charset=utf-8').send(toJacksonJson(body));
}

export function sendOk<T>(reply: FastifyReply, data?: T): FastifyReply {
  return sendJson(reply, 200, ok(data));
}

export function requireUserId(request: FastifyRequest): number {
  const userId = (request as AuthedRequest).userId;
  if (userId == null) {
    throw new BusinessException(ErrorCode.UNAUTHORIZED);
  }
  return userId;
}

export async function requirePermission(
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> },
  userId: number,
  code: string,
): Promise<void> {
  if (!(await permissionService.hasPermission(userId, code))) {
    throw new BusinessException(403, `无权限: ${code}`);
  }
}

export function handleError(err: unknown, _req: FastifyRequest, reply: FastifyReply): void {
  if (err instanceof BusinessException) {
    const http = err.code === 1001 || err.code === 401 ? 401
      : err.code === 1002 || err.code === 403 ? 403
        : 200;
    const code = err.code === 401 ? 1001 : err.code === 403 ? 1002 : err.code;
    sendJson(reply, http === 401 || http === 403 ? http : 200, fail(code, err.message));
    return;
  }
  if (isValidationError(err)) {
    sendJson(reply, 400, fail(ErrorCode.PARAM_INVALID.code, validationMessage(err)));
    return;
  }
  console.error('Unexpected exception', err);
  sendJson(reply, 500, failCode(ErrorCode.INTERNAL_ERROR));
}

function isValidationError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'validation' in (err as object);
}

function validationMessage(err: unknown): string {
  const e = err as { validation?: Array<{ instancePath?: string; message?: string }>; message?: string };
  const first = e.validation?.[0];
  if (first) {
    const field = (first.instancePath ?? '').replace(/^\//, '') || 'param';
    return `${field}: ${first.message ?? ErrorCode.PARAM_INVALID.message}`;
  }
  return e.message ?? ErrorCode.PARAM_INVALID.message;
}
