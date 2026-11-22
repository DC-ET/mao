import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { BusinessException } from './business-exception.js';
import { collectEntityIds, idMapGet, parseEntityId, pathId } from './request.js';

function requestWithParams(params: Record<string, string>): FastifyRequest {
  return { params } as unknown as FastifyRequest;
}

describe('pathId', () => {
  it('parses positive integer path ids', () => {
    expect(pathId(requestWithParams({ id: '1' }))).toBe(1);
    expect(pathId(requestWithParams({ id: '42' }))).toBe(42);
    expect(pathId(requestWithParams({ agentId: '7' }), 'agentId')).toBe(7);
  });

  it('rejects non-integer ids instead of leaking NaN into SQL', () => {
    // 线上案例：GET /v1/agents/list 命中 /v1/agents/:id，NaN 拼进
    // `WHERE id = NaN` 触发 MySQL "Unknown column 'NaN'"，表现为 500。
    for (const raw of ['list', 'enabled', 'abc', '', '1.5', '0', '-3', 'NaN', 'Infinity']) {
      expect(() => pathId(requestWithParams({ id: raw })), `id=${raw}`).toThrow(BusinessException);
    }
  });

  it('throws PARAM_INVALID naming the offending parameter', () => {
    try {
      pathId(requestWithParams({ id: 'list' }));
      throw new Error('expected to throw');
    } catch (e) {
      expect((e as BusinessException).code).toBe(2001);
      expect((e as Error).message).toContain('id');
    }
  });
});

describe('parseEntityId', () => {
  it('coerces numeric strings like Java Long deserialization', () => {
    expect(parseEntityId('9')).toBe(9);
    expect(parseEntityId(9)).toBe(9);
    expect(parseEntityId(null)).toBeNull();
    expect(parseEntityId('')).toBeNull();
    expect(parseEntityId('x')).toBeNull();
  });

  it('collects unique numeric ids and looks them up in maps', () => {
    expect(collectEntityIds(['9', 9, null, 'x'])).toEqual([9]);
    const map = new Map([[9, { name: 'Coder' }]]);
    expect(idMapGet(map, '9')?.name).toBe('Coder');
    expect(idMapGet(map, 9)?.name).toBe('Coder');
    expect(idMapGet(map, '8')).toBeUndefined();
  });
});
