import type { FastifyRequest } from 'fastify';

export function queryMap(request: FastifyRequest): Record<string, string | undefined> {
  return (request.query ?? {}) as Record<string, string | undefined>;
}

export function bodyOf<T>(request: FastifyRequest): T {
  return (request.body ?? {}) as T;
}

export function pathParam(request: FastifyRequest, name: string): string {
  return String((request.params as Record<string, string | undefined>)[name] ?? '');
}

export function pathId(request: FastifyRequest, name = 'id'): number {
  return Number(pathParam(request, name));
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
