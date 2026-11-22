import type { FastifyRequest } from 'fastify';
import { BusinessException } from './business-exception.js';
import { ErrorCode } from './error-code.js';

export function queryMap(request: FastifyRequest): Record<string, string | undefined> {
  return (request.query ?? {}) as Record<string, string | undefined>;
}

export function bodyOf<T>(request: FastifyRequest): T {
  return (request.body ?? {}) as T;
}

export function pathParam(request: FastifyRequest, name: string): string {
  return String((request.params as Record<string, string | undefined>)[name] ?? '');
}

/**
 * 路径参数中的自增 ID。非法值（缺失 / 非数字 / 非正整数）直接抛 PARAM_INVALID（400），
 * 而不是把 NaN 透给 repository：`WHERE id = NaN` 会被 MySQL 当成未知列名而报
 * `Unknown column 'NaN' in 'where clause'`，表现为 500（线上 /v1/agents/list 命中
 * `/v1/agents/:id` 即此路径）。口径与 inbox / open-api-call-log 的本地 pathId 一致。
 */
export function pathId(request: FastifyRequest, name = 'id'): number {
  const id = Number(pathParam(request, name));
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `路径参数 ${name} 必须为正整数`);
  }
  return id;
}

export function queryInt(request: FastifyRequest, name: string, fallback: number): number {
  const raw = queryMap(request)[name];
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function queryOptInt(request: FastifyRequest, name: string): number | undefined {
  const raw = queryMap(request)[name];
  if (raw == null || raw === '') {
    return undefined;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 浮点 query 参数：缺省 / 空串 / 非法值返回 undefined。
 * 与 queryOptInt 的差别只在语义命名——两者都走 Number() 解析，
 * 但金额类阈值（如 trace 的「贵」阈值 0.5）不能用名字暗示「只接受整数」。
 */
export function queryOptFloat(request: FastifyRequest, name: string): number | undefined {
  const raw = queryMap(request)[name];
  if (raw == null || raw === '') {
    return undefined;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export function queryOptStr(request: FastifyRequest, name: string): string | undefined {
  const raw = queryMap(request)[name];
  return raw == null || raw === '' ? undefined : raw;
}

export function queryOptBool(request: FastifyRequest, name: string): boolean | undefined {
  const raw = queryMap(request)[name];
  if (raw == null || raw === '') {
    return undefined;
  }
  if (raw === 'true' || raw === '1') {
    return true;
  }
  if (raw === 'false' || raw === '0') {
    return false;
  }
  return undefined;
}

export function parseEntityId(value: unknown): number | null {
  if (value == null || value === '') {
    return null;
  }
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function collectEntityIds(values: Array<unknown>): number[] {
  const ids: number[] = [];
  for (const value of values) {
    const id = parseEntityId(value);
    if (id != null) {
      ids.push(id);
    }
  }
  return [...new Set(ids)];
}

export function idMapGet<T>(map: Map<number, T>, id: unknown): T | undefined {
  const key = parseEntityId(id);
  return key == null ? undefined : map.get(key);
}
