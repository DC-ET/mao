import type { FastifyRequest } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';

declare module 'fastify' {
  interface FastifyRequest {
    userId?: number;
  }
}

export function requireUserId(request: FastifyRequest): number {
  const id = request.userId;
  if (id == null || !Number.isFinite(Number(id))) {
    throw new BusinessException(ErrorCode.UNAUTHORIZED);
  }
  return Number(id);
}

export function queryString(request: FastifyRequest, name: string): string | undefined {
  const v = (request.query as Record<string, unknown> | undefined)?.[name];
  if (v == null) {
    return undefined;
  }
  return String(v);
}

export function queryInt(request: FastifyRequest, name: string, fallback?: number): number | undefined {
  const v = (request.query as Record<string, unknown> | undefined)?.[name];
  if (v == null || v === '') {
    return fallback;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export function queryLong(request: FastifyRequest, name: string): number | undefined {
  const v = (request.query as Record<string, unknown> | undefined)?.[name];
  if (v == null || v === '') {
    return undefined;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function pathLong(request: FastifyRequest, name: string): number {
  const v = (request.params as Record<string, unknown>)[name];
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `${name} 无效`);
  }
  return n;
}
